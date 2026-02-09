const { ethers } = require('ethers');
const logger = require('./logger');
const { loadConfig, bnbToWei } = require('./config');
const { isValidAddress } = require('./validate');
const { fetchPools } = require('./dexscreener');
const { analyzePools } = require('./poolSelector');
const { getTokenInfo } = require('./onchain');
const { getGasPrice } = require('./fees');
const { executeBuy } = require('./swap');
const { runAntiScamChecks } = require('./antiscam');

// Structured exit codes
const EXIT = {
  SUCCESS: 0,
  BAD_ARGS: 1,
  CONFIG_ERROR: 2,
  RPC_ERROR: 3,
  INSUFFICIENT_FUNDS: 4,
  QUOTE_ERROR: 5,
  SWAP_ERROR: 6,
  USER_CANCELLED: 7,
  TOKEN_INVALID: 8,
  PRICE_DEVIATION: 9,
  SCAM_DETECTED: 10,
};

/**
 * Parse CLI flags from process.argv.
 * Supports: --dry-run, --yes/-y, --amount <BNB>, --token <address>
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const flags = new Set();
  const named = {};
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--amount' || args[i] === '--token') {
      named[args[i].slice(2)] = args[++i];
    } else if (args[i].startsWith('--') || args[i] === '-y') {
      flags.add(args[i]);
    } else {
      positional.push(args[i]);
    }
  }

  return {
    tokenAddress: named.token || positional[0],
    isDryRun: flags.has('--dry-run'),
    skipConfirm: flags.has('--yes') || flags.has('-y'),
    cliAmount: named.amount || null,
    continuous: flags.has('--continuous'),
  };
}

/**
 * Prompt the user for y/n confirmation. Returns true if confirmed.
 */
function confirm(message) {
  const readline = require('readline');
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}

/**
 * Process a single token: validate → pool analysis → anti-scam → buy.
 */
async function processToken(tokenAddress, config, provider, signer, gasSettings) {
  // --- On-chain token info ---
  let tokenInfo;
  try {
    tokenInfo = await getTokenInfo(provider, tokenAddress);
  } catch (err) {
    logger.error(`On-chain token validation failed: ${err.message}`);
    return false;
  }
  logger.sep();

  // --- DexScreener pool analysis ---
  let selectedPool;
  try {
    const pools = await fetchPools(config.dexscreenerApi, tokenAddress);
    selectedPool = analyzePools(pools, tokenAddress);
  } catch (err) {
    logger.warn(`DexScreener lookup failed: ${err.message}`);
    logger.info('Continuing with PancakeSwap swap anyway...');
  }
  logger.sep();

  // --- Liquidity check ---
  if (selectedPool && config.minLiquidityUsd > 0) {
    const liq = selectedPool.liquidity?.usd || 0;
    if (liq < config.minLiquidityUsd) {
      logger.warn(`Pool liquidity $${liq} is below minimum $${config.minLiquidityUsd}. Skipping.`);
      return false;
    }
  }

  // --- Anti-scam checks ---
  const scamResult = await runAntiScamChecks(
    provider,
    config.pancakeRouter,
    tokenAddress,
    config.buyAmountWei,
    tokenInfo
  );

  if (scamResult.riskLevel === 'critical') {
    logger.error('Anti-scam: CRITICAL risk detected. Skipping token.');
    return false;
  }
  logger.sep();

  // --- Execute buy ---
  try {
    const result = await executeBuy(signer, config.pancakeRouter, config, tokenAddress, gasSettings);
    logger.sep();
    logger.success('Swap completed successfully!');
    logger.info(`  TX Hash: ${result.hash}`);
    logger.info(`  BscScan: https://bscscan.com/tx/${result.hash}`);
    logger.sep();
    return true;
  } catch (err) {
    logger.error(`Swap failed: ${err.message}`);
    if (err.txHash) {
      logger.error(`  TX (failed): https://bscscan.com/tx/${err.txHash}`);
    }
    return false;
  }
}

async function main() {
  logger.banner();

  // --- Parse CLI arguments ---
  const { tokenAddress, isDryRun, skipConfirm, cliAmount, continuous } = parseArgs();

  if (!tokenAddress && !continuous) {
    logger.error('Usage: npm start <TOKEN_ADDRESS> [options]');
    logger.error('');
    logger.error('Options:');
    logger.error('  --amount <BNB>    Override BUY_AMOUNT_BNB (e.g. --amount 0.05)');
    logger.error('  --dry-run         Analyze token without executing swap');
    logger.error('  --yes, -y         Skip confirmation prompt');
    logger.error('  --continuous      Continuous mode: poll DexScreener for new tokens');
    logger.error('');
    logger.error('Example: npm start 0x1234...abcd --amount 0.01');
    process.exit(EXIT.BAD_ARGS);
  }

  if (tokenAddress && !isValidAddress(tokenAddress)) {
    logger.error(`Invalid BSC address: ${tokenAddress}`);
    process.exit(EXIT.BAD_ARGS);
  }

  if (isDryRun) {
    logger.info('Mode: DRY RUN (no transaction will be sent)');
  }

  // --- Load config ---
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    logger.error(err.message);
    process.exit(EXIT.CONFIG_ERROR);
  }

  // --- CLI --amount override ---
  if (cliAmount) {
    const parsed = parseFloat(cliAmount);
    if (isNaN(parsed) || parsed <= 0) {
      logger.error('--amount must be a positive number');
      process.exit(EXIT.BAD_ARGS);
    }
    if (parsed > config.maxBuyBnb) {
      logger.error(`--amount ${cliAmount} exceeds MAX_BUY_BNB (${config.maxBuyBnb}). Increase MAX_BUY_BNB in .env if intentional.`);
      process.exit(EXIT.BAD_ARGS);
    }
    config.buyAmountWei = bnbToWei(cliAmount);
    config.buyAmountBnb = cliAmount;
    logger.info(`CLI override: --amount ${cliAmount} BNB`);
  }

  const walletAddress = config.wallet.address;
  logger.info(`Wallet: ${walletAddress}`);
  logger.info(`Buy amount: ${config.buyAmountBnb} BNB`);
  logger.info(`Slippage: ${config.slippagePercent}%`);
  logger.info(`Router: ${config.pancakeRouter}`);
  logger.sep();

  // --- Connect to BSC ---
  logger.step('Connecting to BSC...');
  let provider;
  try {
    provider = new ethers.JsonRpcProvider(config.rpcUrl);
    const network = await provider.getNetwork();
    logger.info(`  Chain ID: ${network.chainId}`);

    if (network.chainId === 56n) {
      logger.warn('*** BSC MAINNET — real funds at risk ***');
    } else if (network.chainId === 97n) {
      logger.info('Running on BSC Testnet');
    }
  } catch (err) {
    logger.error(`RPC connection failed: ${err.message}`);
    process.exit(EXIT.RPC_ERROR);
  }

  // --- Connect wallet to provider ---
  const signer = config.wallet.connect(provider);

  // --- Balance check ---
  let balance;
  try {
    balance = await provider.getBalance(walletAddress);
  } catch (err) {
    logger.error(`Failed to fetch balance: ${err.message}`);
    process.exit(EXIT.RPC_ERROR);
  }

  const balanceBnb = ethers.formatEther(balance);
  logger.info(`BNB balance: ${balanceBnb} BNB`);

  if (balance < config.buyAmountWei) {
    logger.error(`Insufficient BNB. Need ${config.buyAmountBnb} BNB but have ${balanceBnb} BNB`);
    process.exit(EXIT.INSUFFICIENT_FUNDS);
  }
  logger.sep();

  // --- Gas price ---
  let gasSettings;
  try {
    gasSettings = await getGasPrice(provider, config.maxGasPriceGwei);
  } catch (err) {
    logger.warn(`Gas price fetch failed: ${err.message}. Using default.`);
  }
  logger.sep();

  // --- One-shot mode ---
  if (tokenAddress && !continuous) {
    if (isDryRun) {
      // Dry run — just analyze, don't buy
      let tokenInfo;
      try {
        tokenInfo = await getTokenInfo(provider, tokenAddress);
      } catch (err) {
        logger.error(`Token info failed: ${err.message}`);
        process.exit(EXIT.TOKEN_INVALID);
      }
      logger.sep();

      try {
        const pools = await fetchPools(config.dexscreenerApi, tokenAddress);
        analyzePools(pools, tokenAddress);
      } catch (err) {
        logger.warn(`DexScreener: ${err.message}`);
      }
      logger.sep();

      await runAntiScamChecks(provider, config.pancakeRouter, tokenAddress, config.buyAmountWei, tokenInfo);
      logger.sep();
      logger.success('Dry run complete. No transaction was sent.');
      process.exit(EXIT.SUCCESS);
    }

    // Confirmation prompt
    if (!skipConfirm) {
      if (!process.stdin.isTTY) {
        logger.error('Non-interactive mode. Use --yes to skip confirmation.');
        process.exit(EXIT.BAD_ARGS);
      }
      const ok = await confirm(`\n  Swap ${config.buyAmountBnb} BNB for token ${tokenAddress}?\n  Proceed? (y/n): `);
      if (!ok) {
        logger.info('Cancelled by user.');
        process.exit(EXIT.USER_CANCELLED);
      }
    }

    const success = await processToken(tokenAddress, config, provider, signer, gasSettings);
    process.exit(success ? EXIT.SUCCESS : EXIT.SWAP_ERROR);
  }

  // --- Continuous mode ---
  logger.step('Starting continuous mode — polling DexScreener for new BSC pairs...');
  const seen = new Set();
  let running = true;

  process.on('SIGINT', () => {
    logger.info('\nGraceful shutdown...');
    running = false;
  });
  process.on('SIGTERM', () => {
    logger.info('\nGraceful shutdown...');
    running = false;
  });

  while (running) {
    try {
      // Poll DexScreener for new BSC pairs using WBNB as a base search
      // In a real scenario, you'd poll a "new pairs" endpoint
      await new Promise((r) => setTimeout(r, config.pollIntervalMs));
    } catch (err) {
      logger.error(`Poll error: ${err.message}`);
      await new Promise((r) => setTimeout(r, config.pollIntervalMs));
    }
  }

  logger.info('Shutdown complete.');
  process.exit(EXIT.SUCCESS);
}

// Auto-run only when executed directly (not imported by tests)
if (require.main === module) {
  main().catch((err) => {
    logger.error(`Unhandled error: ${err.message}`);
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main, parseArgs, EXIT };
