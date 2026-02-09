require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');

const SOL_MINT = 'So11111111111111111111111111111111111111112';

const JUPITER_API = {
  quote: 'https://quote-api.jup.ag/v6/quote',
  swap: 'https://quote-api.jup.ag/v6/swap',
};

const DEXSCREENER_API = 'https://api.dexscreener.com/latest/dex/tokens';

// Known genesis hashes for network detection
const GENESIS_HASHES = {
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d': 'mainnet-beta',
  'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG': 'devnet',
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z': 'testnet',
};

/**
 * Convert SOL string to lamports using integer arithmetic (no float rounding issues).
 */
function solToLamports(solString) {
  const parts = solString.split('.');
  const whole = parts[0] || '0';
  const frac = parts[1] || '';
  const paddedFrac = frac.padEnd(9, '0').slice(0, 9);
  return parseInt(whole, 10) * 1_000_000_000 + parseInt(paddedFrac, 10);
}

/**
 * Parse a private key from base58 string or JSON byte array.
 */
function loadKeypair(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return Keypair.fromSecretKey(Uint8Array.from(parsed));
  } catch {
    return Keypair.fromSecretKey(bs58.decode(raw));
  }
}

/**
 * Load private key from PRIVATE_KEY env var or PRIVATE_KEY_PATH file.
 * Returns the raw key string. Caller must parse with loadKeypair().
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

    // Check file permissions on Unix — warn if world-readable
    if (process.platform !== 'win32') {
      try {
        const stat = fs.statSync(resolved);
        const mode = stat.mode & 0o777;
        if (mode & 0o044) {
          // File is readable by group or others
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
 * Detect Solana network from genesis hash.
 * Returns 'mainnet-beta', 'devnet', 'testnet', or 'unknown'.
 */
async function detectNetwork(connection) {
  try {
    const genesisHash = await connection.getGenesisHash();
    return GENESIS_HASHES[genesisHash] || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Create a safe config object that won't leak the private key
 * if accidentally serialized (JSON.stringify, console.log, etc.).
 */
function createSafeConfig(configData) {
  const config = { ...configData };

  // Override toJSON to redact keypair
  config.toJSON = function () {
    const { keypair, ...safe } = this;
    return {
      ...safe,
      keypair: keypair ? `[Keypair: ${keypair.publicKey.toBase58()}]` : undefined,
      toJSON: undefined,
    };
  };

  // Override inspect for console.log / util.inspect
  const inspect = Symbol.for('nodejs.util.inspect.custom');
  config[inspect] = function () {
    return this.toJSON();
  };

  return config;
}

function loadConfig() {
  checkEnvFilePermissions();

  const rpcUrl = process.env.SOLANA_RPC_URL;
  const buyAmountSol = process.env.BUY_AMOUNT_SOL;
  const slippageBps = parseInt(process.env.SLIPPAGE_BPS || '500', 10);
  const priorityFee = process.env.PRIORITY_FEE || 'auto';
  const maxBuySol = parseFloat(process.env.MAX_BUY_SOL || '10');

  const errors = [];
  if (!rpcUrl) errors.push('SOLANA_RPC_URL is required in .env');
  if (!buyAmountSol || isNaN(parseFloat(buyAmountSol))) {
    errors.push('BUY_AMOUNT_SOL must be a valid number in .env');
  } else if (parseFloat(buyAmountSol) <= 0) {
    errors.push('BUY_AMOUNT_SOL must be greater than 0');
  } else if (parseFloat(buyAmountSol) > maxBuySol) {
    errors.push(`BUY_AMOUNT_SOL (${buyAmountSol}) exceeds MAX_BUY_SOL (${maxBuySol}). Increase MAX_BUY_SOL in .env if intentional.`);
  }
  if (isNaN(slippageBps) || slippageBps < 0) errors.push('SLIPPAGE_BPS must be a non-negative integer');
  if (slippageBps > 5000) errors.push('SLIPPAGE_BPS exceeds 5000 (50%) — likely a mistake');

  // Load private key (inline or from file)
  let privateKeyRaw;
  try {
    privateKeyRaw = loadPrivateKeyRaw();
  } catch (err) {
    errors.push(err.message);
  }

  if (!privateKeyRaw) {
    errors.push('PRIVATE_KEY or PRIVATE_KEY_PATH is required');
  }

  if (errors.length > 0) {
    throw new Error('Configuration errors:\n  - ' + errors.join('\n  - '));
  }

  let keypair;
  try {
    keypair = loadKeypair(privateKeyRaw);
  } catch (err) {
    throw new Error(`Failed to parse PRIVATE_KEY: ${err.message}`);
  }

  const amountLamports = solToLamports(buyAmountSol);

  return createSafeConfig({
    rpcUrl,
    keypair,
    buyAmountSol,
    amountLamports,
    slippageBps,
    priorityFee,
    solMint: SOL_MINT,
    jupiterApi: JUPITER_API,
    dexscreenerApi: DEXSCREENER_API,
  });
}

module.exports = {
  loadConfig,
  solToLamports,
  detectNetwork,
  createSafeConfig,
  loadPrivateKeyRaw,
  SOL_MINT,
  JUPITER_API,
  DEXSCREENER_API,
  GENESIS_HASHES,
};
