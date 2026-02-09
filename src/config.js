require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const PANCAKE_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const PANCAKE_FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';

const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';

const NATIVE_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const USDT = '0x55d398326f99059fF775485246999027B3197955';
const USDC = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';
const BUSD = '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56';

const DEXSCREENER_API = 'https://api.dexscreener.com/latest/dex/tokens';

/**
 * Convert BNB string to wei using integer arithmetic (no float rounding issues).
 * BNB uses 18 decimals.
 */
function bnbToWei(bnbString) {
  const parts = bnbString.split('.');
  const whole = parts[0] || '0';
  const frac = parts[1] || '';
  const paddedFrac = frac.padEnd(18, '0').slice(0, 18);
  return BigInt(whole) * 1_000_000_000_000_000_000n + BigInt(paddedFrac);
}

/**
 * Load private key from PRIVATE_KEY env var or PRIVATE_KEY_PATH file.
 * Returns the raw key string.
 */
function loadPrivateKeyRaw() {
  const keyPath = process.env.PRIVATE_KEY_PATH;
  const keyInline = process.env.PRIVATE_KEY;

  if (keyPath && keyInline) {
    throw new Error('Both PRIVATE_KEY and PRIVATE_KEY_PATH are set. Use only one.');
  }

  if (keyPath) {
    const resolved = path.resolve(keyPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`PRIVATE_KEY_PATH file not found: ${resolved}`);
    }

    if (process.platform !== 'win32') {
      try {
        const stat = fs.statSync(resolved);
        const mode = stat.mode & 0o777;
        if (mode & 0o044) {
          console.error(
            `[SECURITY WARNING] Key file ${resolved} is readable by others (mode: ${mode.toString(8)}). ` +
              'Run: chmod 600 ' + resolved
          );
        }
      } catch { /* stat failed, skip permission check */ }
    }

    return fs.readFileSync(resolved, 'utf-8').trim();
  }

  if (keyInline) {
    return keyInline;
  }

  return null;
}

/**
 * Check .env file permissions on Unix systems.
 */
function checkEnvFilePermissions() {
  if (process.platform === 'win32') return;

  const envPath = path.resolve('.env');
  if (!fs.existsSync(envPath)) return;

  try {
    const stat = fs.statSync(envPath);
    const mode = stat.mode & 0o777;
    if (mode & 0o044) {
      console.error(
        `[SECURITY WARNING] .env file is readable by others (mode: ${mode.toString(8)}). ` +
          'Run: chmod 600 .env'
      );
    }
  } catch { /* stat failed, skip */ }
}

/**
 * Create a safe config object that won't leak the private key
 * if accidentally serialized (JSON.stringify, console.log, etc.).
 */
function createSafeConfig(configData) {
  const config = { ...configData };

  config.toJSON = function () {
    const { wallet, ...safe } = this;
    return {
      ...safe,
      wallet: wallet ? `[Wallet: ${wallet.address}]` : undefined,
      toJSON: undefined,
    };
  };

  const inspect = Symbol.for('nodejs.util.inspect.custom');
  config[inspect] = function () {
    return this.toJSON();
  };

  return config;
}

function loadConfig() {
  checkEnvFilePermissions();

  const rpcUrl = process.env.RPC_URL;
  const buyAmountBnb = process.env.BUY_AMOUNT_BNB;
  const slippagePercent = parseFloat(process.env.SLIPPAGE_PERCENT || '5');
  const gasLimit = parseInt(process.env.GAS_LIMIT || '300000', 10);
  const maxGasPriceGwei = parseFloat(process.env.MAX_GAS_PRICE_GWEI || '5');
  const buyRetries = parseInt(process.env.BUY_RETRIES || '3', 10);
  const buyRetryDelayMs = parseInt(process.env.BUY_RETRY_DELAY_MS || '500', 10);
  const simulateBeforeBuy = (process.env.SIMULATE_BEFORE_BUY || 'false').toLowerCase() === 'true';
  const maxBuyBnb = parseFloat(process.env.MAX_BUY_BNB || '1');
  const minLiquidityUsd = parseFloat(process.env.MIN_LIQUIDITY_USD || '1000');
  const maxTokenAgeSec = parseInt(process.env.MAX_TOKEN_AGE_SEC || '300', 10);
  const pollIntervalMs = parseInt(process.env.POLL_INTERVAL_MS || '3000', 10);
  const routerZeroxApiKey = process.env.ROUTER_ZERO_X_API_KEY;
  const zeroxApiUrl = process.env.ZEROX_API_URL || 'https://api.0x.org';

  const errors = [];
  if (!rpcUrl) errors.push('RPC_URL is required in .env');
  if (!routerZeroxApiKey) errors.push('ROUTER_ZERO_X_API_KEY is required in .env');
  if (!buyAmountBnb || isNaN(parseFloat(buyAmountBnb))) {
    errors.push('BUY_AMOUNT_BNB must be a valid number in .env');
  } else if (parseFloat(buyAmountBnb) <= 0) {
    errors.push('BUY_AMOUNT_BNB must be greater than 0');
  } else if (parseFloat(buyAmountBnb) > maxBuyBnb) {
    errors.push(`BUY_AMOUNT_BNB (${buyAmountBnb}) exceeds MAX_BUY_BNB (${maxBuyBnb}). Increase MAX_BUY_BNB in .env if intentional.`);
  }
  if (isNaN(slippagePercent) || slippagePercent < 0) errors.push('SLIPPAGE_PERCENT must be a non-negative number');
  if (slippagePercent > 50) errors.push('SLIPPAGE_PERCENT exceeds 50% — likely a mistake');
  if (isNaN(gasLimit) || gasLimit <= 0) errors.push('GAS_LIMIT must be a positive integer');
  if (isNaN(maxGasPriceGwei) || maxGasPriceGwei <= 0) errors.push('MAX_GAS_PRICE_GWEI must be a positive number');

  // Load private key
  let privateKeyRaw;
  let keyLoadError = false;
  try {
    privateKeyRaw = loadPrivateKeyRaw();
  } catch (err) {
    errors.push(err.message);
    keyLoadError = true;
  }

  if (!privateKeyRaw && !keyLoadError) {
    errors.push('PRIVATE_KEY or PRIVATE_KEY_PATH is required');
  }

  if (errors.length > 0) {
    throw new Error('Configuration errors:\n  - ' + errors.join('\n  - '));
  }

  // Normalize private key — add 0x prefix if missing
  let normalizedKey = privateKeyRaw;
  if (!normalizedKey.startsWith('0x')) {
    normalizedKey = '0x' + normalizedKey;
  }

  let wallet;
  try {
    wallet = new ethers.Wallet(normalizedKey);
  } catch (err) {
    throw new Error(`Failed to parse PRIVATE_KEY: ${err.message}`);
  }

  const buyAmountWei = bnbToWei(buyAmountBnb);
  const slippageBps = Math.round(slippagePercent * 100);

  return createSafeConfig({
    rpcUrl,
    wallet,
    buyAmountBnb,
    buyAmountWei,
    slippagePercent,
    slippageBps,
    gasLimit,
    maxGasPriceGwei,
    buyRetries,
    buyRetryDelayMs,
    simulateBeforeBuy,
    maxBuyBnb,
    minLiquidityUsd,
    maxTokenAgeSec,
    pollIntervalMs,
    dexscreenerApi: DEXSCREENER_API,
    pancakeFactory: PANCAKE_FACTORY,
    wbnb: WBNB,
    routerZeroxApiKey,
    zeroxApiUrl,
    nativeToken: NATIVE_TOKEN,
  });
}

module.exports = {
  loadConfig,
  bnbToWei,
  createSafeConfig,
  loadPrivateKeyRaw,
  PANCAKE_ROUTER,
  PANCAKE_FACTORY,
  WBNB,
  USDT,
  USDC,
  BUSD,
  NATIVE_TOKEN,
  DEXSCREENER_API,
};
