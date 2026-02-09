const readline = require('readline');
const { Connection, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const logger = require('./logger');
const { loadConfig, solToLamports, detectNetwork } = require('./config');
const { httpsAgent } = require('./http');
const { isValidSolanaMint } = require('./validate');
const { fetchPools } = require('./dexscreener');
const { analyzePools } = require('./poolSelector');
const { getQuote, executeSwap } = require('./jupiter');
const { validateTokenMint, validatePoolAccount } = require('./onchain');
const { estimatePriorityFee } = require('./fees');
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

// Quote freshness settings
const QUOTE_MAX_AGE_MS = 10_000;       // re-quote if older than 10s
const PRICE_WARN_PCT = 2;              // warn if price moved >2%
const PRICE_ABORT_PCT = 10;            // abort if price moved >10%
const FEE_RESERVE_LAMPORTS = 5_000_000; // 0.005 SOL reserved for tx fees

/**
 * Parse CLI flags from process.argv.
 * Supports: --dry-run, --yes/-y, --amount <SOL>, --percent <N>
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const flags = new Set();
  const named = {};
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--amount' || args[i] === '--percent') {
      named[args[i].slice(2)] = args[++i];
    } else if (args[i].startsWith('--') || args[i] === '-y') {
      flags.add(args[i]);
    } else {
      positional.push(args[i]);
    }
  }

  return {
    tokenMint: positional[0],
    isDryRun: flags.has('--dry-run'),
    skipConfirm: flags.has('--yes') || flags.has('-y'),
    cliAmount: named.amount || null,
    cliPercent: named.percent || null,
  };
}

/**
 * Prompt the user for y/n confirmation. Returns true if confirmed.
 */
function confirm(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}

/**
 * RPC warmup — establishes TCP keep-alive connection and caches
 * critical RPC data so the swap tx goes through an already-hot connection.
 */
async function warmupRpc(connection, publicKey) {
  logger.step('Warming up RPC connection...');
  const start = Date.now();

  const version = await connection.getVersion();
  logger.info(`  Node version: ${version['solana-core']}`);

  const slot = await connection.getSlot();
  logger.info(`  Current slot: ${slot}`);

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  logger.info(`  Latest blockhash: ${blockhash.slice(0, 16)}... (valid until block ${lastValidBlockHeight})`);

  const balance = await connection.getBalance(publicKey);

  const elapsed = Date.now() - start;
  logger.success(`RPC warmed up in ${elapsed}ms (4 calls over keep-alive connection)`);

  return { balance, blockhash, lastValidBlockHeight, slot };
}

async function main() {
  logger.banner();

  // --- Parse CLI arguments ---
  const { tokenMint, isDryRun, skipConfirm, cliAmount, cliPercent } = parseArgs();

  if (!tokenMint) {
    logger.error('Usage: npm start <TOKEN_MINT> [options]');
    logger.error('');
    logger.error('Options:');
    logger.error('  --amount <SOL>    Override BUY_AMOUNT_SOL (e.g. --amount 0.5)');
    logger.error('  --percent <N>     Use N% of wallet balance (e.g. --percent 50)');
    logger.error('  --dry-run         Get quote and route without executing the swap');
    logger.error('  --yes, -y         Skip confirmation prompt');
    logger.error('');
    logger.error('Example: npm start EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --amount 0.1');
    process.exit(EXIT.BAD_ARGS);
  }

  if (cliAmount && cliPercent) {
    logger.error('Cannot use --amount and --percent together. Choose one.');
    process.exit(EXIT.BAD_ARGS);
  }

  if (!isValidSolanaMint(tokenMint)) {
    logger.error(`Invalid Solana mint address: ${tokenMint}`);
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
    const maxBuySol = parseFloat(process.env.MAX_BUY_SOL || '10');
    if (parsed > maxBuySol) {
      logger.error(`--amount ${cliAmount} exceeds MAX_BUY_SOL (${maxBuySol}). Increase MAX_BUY_SOL in .env if intentional.`);
      process.exit(EXIT.BAD_ARGS);
    }
    config.amountLamports = solToLamports(cliAmount);
    config.buyAmountSol = cliAmount;
    logger.info(`CLI override: --amount ${cliAmount} SOL (${config.amountLamports} lamports)`);
  }

  const walletAddress = config.keypair.publicKey.toBase58();
  logger.info(`Token mint: ${tokenMint}`);
  logger.info(`Buy amount: ${config.buyAmountSol} SOL`);
  logger.info(`Slippage: ${config.slippageBps} bps (${config.slippageBps / 100}%)`);
  logger.info(`Wallet: ${walletAddress}`);
  logger.sep();

  // --- Create connection with keep-alive ---
  logger.step('Connecting to Solana (keep-alive enabled)...');
  const connection = new Connection(config.rpcUrl, {
    commitment: 'confirmed',
    httpAgent: httpsAgent,
  });

  // --- RPC warmup ---
  let warmup;
  try {
    warmup = await warmupRpc(connection, config.keypair.publicKey);
  } catch (err) {
    logger.error(`RPC warmup failed: ${err.message}`);
    process.exit(EXIT.RPC_ERROR);
  }

  // --- Network detection ---
  const network = await detectNetwork(connection);
  logger.info(`Network: ${network}`);

  if (network === 'mainnet-beta') {
    logger.warn('*** MAINNET DETECTED — real funds at risk ***');
    if (!skipConfirm && !isDryRun) {
      if (!process.stdin.isTTY) {
        logger.error('Mainnet detected in non-interactive mode. Use --yes to confirm.');
        process.exit(EXIT.BAD_ARGS);
      }
      const ok = await confirm('  You are on MAINNET. Continue? (y/n): ');
      if (!ok) {
        logger.info('Cancelled by user (mainnet safety check).');
        process.exit(EXIT.USER_CANCELLED);
      }
    }
  } else if (network === 'devnet' || network === 'testnet') {
    logger.info(`Running on ${network} (test network)`);
  } else {
    logger.warn(`Unknown network (genesis hash not recognized). Proceed with caution.`);
  }

  const balanceSol = warmup.balance / LAMPORTS_PER_SOL;
  logger.info(`SOL balance: ${balanceSol} SOL`);

  // --- CLI --percent override (needs balance) ---
  if (cliPercent) {
    const pct = parseFloat(cliPercent);
    if (isNaN(pct) || pct <= 0 || pct > 100) {
      logger.error('--percent must be between 0 and 100');
      process.exit(EXIT.BAD_ARGS);
    }
    const available = Math.max(0, warmup.balance - FEE_RESERVE_LAMPORTS);
    config.amountLamports = Math.floor(available * pct / 100);
    config.buyAmountSol = (config.amountLamports / LAMPORTS_PER_SOL).toString();

    const maxBuySol = parseFloat(process.env.MAX_BUY_SOL || '10');
    if (parseFloat(config.buyAmountSol) > maxBuySol) {
      logger.error(`${pct}% of balance = ${config.buyAmountSol} SOL, exceeds MAX_BUY_SOL (${maxBuySol}).`);
      process.exit(EXIT.BAD_ARGS);
    }
    logger.info(`CLI override: --percent ${pct}% of available balance = ${config.buyAmountSol} SOL (${config.amountLamports} lamports)`);
    logger.info(`  (${FEE_RESERVE_LAMPORTS / LAMPORTS_PER_SOL} SOL reserved for fees)`);
  }

  if (warmup.balance < config.amountLamports) {
    logger.error(
      `Insufficient SOL. Need ${config.buyAmountSol} SOL but have ${balanceSol} SOL`
    );
    process.exit(EXIT.INSUFFICIENT_FUNDS);
  }
  logger.sep();

  // --- Network fee estimation ---
  const networkFees = await estimatePriorityFee(connection);
  logger.sep();

  // --- On-chain token validation ---
  let tokenInfo;
  try {
    tokenInfo = await validateTokenMint(connection, tokenMint);
    if (!tokenInfo.valid) {
      logger.error(`Token mint validation failed: ${tokenInfo.reason}`);
      process.exit(EXIT.TOKEN_INVALID);
    }
  } catch (err) {
    logger.error(`On-chain validation failed: ${err.message}`);
    process.exit(EXIT.TOKEN_INVALID);
  }
  logger.sep();

  // --- Fetch pools from DexScreener (informational) ---
  let selectedPool;
  try {
    const pools = await fetchPools(config.dexscreenerApi, tokenMint);
    selectedPool = analyzePools(pools, tokenMint);
  } catch (err) {
    logger.warn(`DexScreener lookup failed: ${err.message}`);
    logger.info('Continuing with Jupiter swap anyway...');
    logger.sep();
  }

  // --- On-chain pool validation (if DexScreener returned a pool) ---
  if (selectedPool?.pairAddress) {
    try {
      const poolCheck = await validatePoolAccount(connection, selectedPool.pairAddress);
      if (!poolCheck.exists) {
        logger.warn(`Selected pool does not exist on-chain: ${poolCheck.reason}`);
        logger.warn('DexScreener data may be stale. Jupiter will route independently.');
      } else {
        logger.success(`Pool account verified on-chain (owner: ${poolCheck.owner}, data: ${poolCheck.dataSize} bytes)`);
      }
    } catch (err) {
      logger.warn(`Pool on-chain check failed: ${err.message}`);
    }
    logger.sep();
  }

  // --- Get Jupiter quote ---
  let quoteResponse;
  let quoteTimestamp;
  try {
    quoteResponse = await getQuote(config, tokenMint);
    quoteTimestamp = Date.now();
  } catch (err) {
    logger.error(`Jupiter quote failed: ${err.message}`);
    process.exit(EXIT.QUOTE_ERROR);
  }

  // --- Anti-scam checks ---
  const scamResult = await runAntiScamChecks(config, tokenMint, tokenInfo, quoteResponse);
  if (scamResult.riskLevel === 'critical') {
    if (!skipConfirm) {
      logger.error('Anti-scam: CRITICAL risk detected. Aborting to protect funds.');
      logger.error('Use --yes to override this safety check.');
      process.exit(EXIT.SCAM_DETECTED);
    }
    logger.warn('Anti-scam: CRITICAL risk detected but --yes flag is set. Proceeding...');
  }
  logger.sep();

  // --- Dry-run: stop here ---
  if (isDryRun) {
    logger.sep();
    logger.success('Dry run complete. No transaction was sent.');
    process.exit(EXIT.SUCCESS);
  }

  // --- Confirmation prompt ---
  if (!skipConfirm) {
    if (!process.stdin.isTTY) {
      logger.error('Non-interactive mode detected. Use --yes to skip confirmation.');
      process.exit(EXIT.BAD_ARGS);
    }

    logger.sep();
    const amountWarning = parseFloat(config.buyAmountSol) >= 1 ? ' (!)' : '';

    // Human-readable output amounts (if decimals known from on-chain validation)
    const decimals = tokenInfo.decimals || 0;
    const expectedHuman = decimals > 0
      ? (Number(BigInt(quoteResponse.outAmount)) / 10 ** decimals).toLocaleString(undefined, { maximumFractionDigits: decimals })
      : quoteResponse.outAmount;
    const minHuman = decimals > 0
      ? (Number(BigInt(quoteResponse.otherAmountThreshold)) / 10 ** decimals).toLocaleString(undefined, { maximumFractionDigits: decimals })
      : quoteResponse.otherAmountThreshold;

    const prompt =
      `\n  Spend: ${config.buyAmountSol} SOL${amountWarning}\n` +
      `  Expected output: ${expectedHuman} tokens (${quoteResponse.outAmount} raw)\n` +
      `  Min output (amountOutMin): ${minHuman} tokens (${quoteResponse.otherAmountThreshold} raw)\n` +
      `  Price impact: ${quoteResponse.priceImpactPct || 'N/A'}%\n` +
      `  Slippage: ${config.slippageBps} bps (${config.slippageBps / 100}%)\n` +
      `  Risk level: ${scamResult.riskLevel.toUpperCase()}\n\n` +
      `  Proceed with swap? (y/n): `;

    const ok = await confirm(prompt);
    if (!ok) {
      logger.info('Swap cancelled by user.');
      process.exit(EXIT.USER_CANCELLED);
    }
  }

  // --- Quote freshness check — re-quote if stale ---
  const quoteAge = Date.now() - quoteTimestamp;
  if (quoteAge > QUOTE_MAX_AGE_MS) {
    logger.warn(`Quote is ${Math.round(quoteAge / 1000)}s old (max: ${QUOTE_MAX_AGE_MS / 1000}s). Re-quoting...`);
    try {
      const freshQuote = await getQuote(config, tokenMint);
      const oldOut = BigInt(quoteResponse.outAmount);
      const newOut = BigInt(freshQuote.outAmount);

      // Negative = price got worse (we receive less)
      const deviationPct = oldOut > 0n
        ? Number((newOut - oldOut) * 10000n / oldOut) / 100
        : 0;

      if (Math.abs(deviationPct) > PRICE_WARN_PCT) {
        const direction = deviationPct < 0 ? 'worse' : 'better';
        logger.warn(`Price moved ${Math.abs(deviationPct).toFixed(2)}% ${direction} since initial quote`);
        logger.warn(`  Old output: ${quoteResponse.outAmount} → New output: ${freshQuote.outAmount}`);
      }

      if (deviationPct < -PRICE_ABORT_PCT && !skipConfirm) {
        logger.error(`Price dropped ${Math.abs(deviationPct).toFixed(2)}% (>${PRICE_ABORT_PCT}%). Aborting to protect funds.`);
        logger.error('Use --yes to override this safety check.');
        process.exit(EXIT.PRICE_DEVIATION);
      }

      quoteResponse = freshQuote;
      quoteTimestamp = Date.now();
      logger.success('Using fresh quote for swap');
    } catch (err) {
      logger.warn(`Re-quote failed: ${err.message}. Using original quote (${Math.round(quoteAge / 1000)}s old).`);
    }
  }

  // --- Execute swap ---
  logger.step(`Swapping ${config.buyAmountSol} SOL for token...`);

  let txSignature;
  try {
    txSignature = await executeSwap(config, quoteResponse, connection, {
      networkFeeEstimate: networkFees?.high,
    });
  } catch (err) {
    logger.error(`Swap failed: ${err.message}`);

    // Log full swap context for post-mortem
    logger.error(`  Token: ${tokenMint}`);
    logger.error(`  Amount: ${config.buyAmountSol} SOL (${config.amountLamports} lamports)`);
    logger.error(`  Slippage: ${config.slippageBps} bps`);
    logger.error(`  Expected output: ${quoteResponse.outAmount} (raw)`);
    logger.error(`  Min output: ${quoteResponse.otherAmountThreshold} (raw)`);

    if (err.txId) {
      logger.error(`  TX (failed): https://solscan.io/tx/${err.txId}`);
    }

    if (err.message.includes('Slippage') || err.message.includes('slippage')) {
      logger.warn('Try increasing SLIPPAGE_BPS in .env or use a lower --amount');
    }
    if (err.message.includes('timed out')) {
      logger.warn('The transaction may still land. Check the explorer.');
    }
    if (err.message.includes('Insufficient')) {
      logger.warn('Wallet may not have enough SOL (including fees). Check balance.');
    }
    process.exit(EXIT.SWAP_ERROR);
  }

  // --- Final result ---
  logger.sep();
  logger.success('Swap completed successfully!');
  logger.info(`TX Signature: ${txSignature}`);
  logger.info(`Solscan: https://solscan.io/tx/${txSignature}`);
  logger.info(`Solana Explorer: https://explorer.solana.com/tx/${txSignature}`);
  logger.sep();
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
