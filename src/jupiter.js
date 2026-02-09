const { client } = require('./http');
const { withRetry } = require('./retry');
const { VersionedTransaction } = require('@solana/web3.js');
const logger = require('./logger');

const TX_CONFIRM_TIMEOUT_MS = 60_000;
const SWAP_MAX_RETRIES = 2;
const FEE_BUMP_MULTIPLIER = 1.5;
const DEFAULT_RETRY_FEE_LAMPORTS = 100_000;

// Common Solana program error codes → human-readable messages
const PROGRAM_ERRORS = {
  0: 'Not enough lamports',
  1: 'Insufficient funds',
  // Jupiter / AMM specific
  6000: 'Slippage tolerance exceeded',
  6001: 'Slippage tolerance exceeded',
  6002: 'Invalid route / zero output',
  6003: 'Exceeds desired slippage limit',
};

/**
 * Parse Solana transaction error into a human-readable string.
 * Input format: { InstructionError: [index, { Custom: code }] } or similar.
 */
function parseTransactionError(err) {
  if (!err) return 'unknown error';

  if (typeof err === 'string') return err;

  // InstructionError: [instructionIndex, errorDetail]
  if (err.InstructionError) {
    const [idx, detail] = err.InstructionError;
    if (detail?.Custom !== undefined) {
      const code = detail.Custom;
      const readable = PROGRAM_ERRORS[code] || `program error code ${code}`;
      return `Instruction #${idx}: ${readable} (Custom: ${code})`;
    }
    if (typeof detail === 'string') {
      return `Instruction #${idx}: ${detail}`;
    }
    return `Instruction #${idx}: ${JSON.stringify(detail)}`;
  }

  // DuplicateInstruction, InsufficientFundsForRent, etc.
  return JSON.stringify(err);
}

/**
 * Attempt to fetch transaction logs from the chain for failed tx diagnostics.
 * Returns log lines array or null.
 */
async function fetchTransactionLogs(connection, txId) {
  try {
    const tx = await connection.getTransaction(txId, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    return tx?.meta?.logMessages || null;
  } catch {
    return null;
  }
}

/**
 * Get a swap quote from Jupiter V6 API.
 */
async function getQuote(config, tokenMint) {
  logger.step('Getting quote from Jupiter...');

  const params = {
    inputMint: config.solMint,
    outputMint: tokenMint,
    amount: config.amountLamports,
    slippageBps: config.slippageBps,
  };

  logger.info(`Input: ${config.buyAmountSol} SOL (${config.amountLamports} lamports)`);
  logger.info(`Output mint: ${tokenMint}`);
  logger.info(`Slippage: ${config.slippageBps} bps (${config.slippageBps / 100}%)`);

  const { data } = await withRetry(
    () => client.get(config.jupiterApi.quote, { params, timeout: 15000 }),
    {
      retries: 3,
      baseDelay: 1000,
      onRetry: (attempt, delay) =>
        logger.warn(`Jupiter quote retry #${attempt} in ${delay}ms...`),
    }
  );

  if (!data || !data.outAmount) {
    throw new Error('Jupiter returned no quote. Token may have no liquidity.');
  }

  logger.success('Quote received from Jupiter');
  logger.info(`  Expected output: ${data.outAmount} (raw)`);
  logger.info(`  Min output (after slippage): ${data.otherAmountThreshold} (raw)`);
  logger.info(`  Price impact: ${data.priceImpactPct || 'N/A'}%`);
  logger.info(`  Swap mode: ${data.swapMode || 'ExactIn'}`);

  // Log human-readable amounts if token decimals are known from route
  if (data.routePlan && data.routePlan.length > 0) {
    logger.sep();
    logger.step(`Jupiter route plan (${data.routePlan.length} hop(s)):`);
    data.routePlan.forEach((step, i) => logger.route(step, i));

    // Log input/output mints for clarity
    const firstHop = data.routePlan[0]?.swapInfo;
    const lastHop = data.routePlan[data.routePlan.length - 1]?.swapInfo;
    if (firstHop?.inputMint && lastHop?.outputMint) {
      logger.info(`  Route: ${firstHop.inputMint.slice(0, 8)}... → ${lastHop.outputMint.slice(0, 8)}...`);
    }

    logger.sep();
  }

  return data;
}

/**
 * Build, sign, send, and confirm a single swap transaction.
 * Called by executeSwap — may be retried with different priority fees.
 */
async function sendSwapTransaction(config, quoteResponse, connection, priorityFee, attempt) {
  if (attempt > 0) {
    logger.step(`Rebuilding swap transaction (attempt ${attempt + 1}, fee: ${priorityFee} lamports)...`);
  } else {
    logger.step('Building swap transaction via Jupiter...');
  }

  const swapBody = {
    quoteResponse,
    userPublicKey: config.keypair.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
  };

  if (priorityFee === 'auto') {
    swapBody.prioritizationFeeLamports = 'auto';
    logger.info('Priority fee: auto');
  } else if (!isNaN(priorityFee) && priorityFee > 0) {
    swapBody.prioritizationFeeLamports = priorityFee;
    logger.info(`Priority fee: ${priorityFee} lamports`);
  } else {
    logger.warn(`Invalid PRIORITY_FEE value ("${config.priorityFee}"), skipping. Use "auto" or a positive number.`);
  }

  const { data } = await withRetry(
    () => client.post(config.jupiterApi.swap, swapBody, { timeout: 30000 }),
    {
      retries: 2,
      baseDelay: 2000,
      onRetry: (a, delay) =>
        logger.warn(`Jupiter swap-build retry #${a} in ${delay}ms...`),
    }
  );

  if (!data || !data.swapTransaction) {
    throw new Error('Jupiter did not return a swap transaction.');
  }

  logger.success('Swap transaction received from Jupiter');

  // Deserialize and sign
  const txBuf = Buffer.from(data.swapTransaction, 'base64');
  const transaction = VersionedTransaction.deserialize(txBuf);
  transaction.sign([config.keypair]);
  logger.info('Transaction signed');

  // Get fresh blockhash for confirmation strategy
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash('confirmed');

  // Send
  logger.info('Sending transaction to Solana...');
  const txId = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  logger.info(`Transaction sent! Signature: ${txId}`);
  logger.info('Waiting for confirmation...');

  // Confirm with blockhash strategy + hard timeout
  const confirmPromise = connection.confirmTransaction(
    { signature: txId, blockhash, lastValidBlockHeight },
    'confirmed'
  );

  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Transaction confirmation timed out after ${TX_CONFIRM_TIMEOUT_MS / 1000}s`)),
      TX_CONFIRM_TIMEOUT_MS
    );
  });

  let confirmation;
  try {
    confirmation = await Promise.race([confirmPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }

  if (confirmation?.value?.err) {
    const parsed = parseTransactionError(confirmation.value.err);
    logger.error(`Transaction failed on-chain: ${parsed}`);
    logger.error(`  TX Signature: ${txId}`);
    logger.error(`  Solscan: https://solscan.io/tx/${txId}`);

    // Try to fetch logs for deeper diagnostics
    const logs = await fetchTransactionLogs(connection, txId);
    if (logs && logs.length > 0) {
      logger.error('  Transaction logs:');
      // Log last 10 lines (most relevant — error is usually at end)
      const tail = logs.slice(-10);
      tail.forEach((line) => logger.error(`    ${line}`));
    }

    const error = new Error(`Transaction failed on-chain: ${parsed}`);
    error.txId = txId;
    error.onChainError = confirmation.value.err;
    throw error;
  }

  return txId;
}

/**
 * Execute a swap via Jupiter with automatic retry + priority fee bumping.
 *
 * On timeout or blockhash expiry, re-requests the swap transaction from Jupiter
 * with a higher priority fee and retries (up to SWAP_MAX_RETRIES times).
 *
 * @param {object} opts.networkFeeEstimate - p75 fee in lamports from estimatePriorityFee()
 */
async function executeSwap(config, quoteResponse, connection, opts = {}) {
  const { networkFeeEstimate } = opts;
  const initialFee =
    config.priorityFee === 'auto' ? 'auto' : parseInt(config.priorityFee, 10);

  let currentFee = initialFee;

  for (let attempt = 0; attempt <= SWAP_MAX_RETRIES; attempt++) {
    try {
      return await sendSwapTransaction(config, quoteResponse, connection, currentFee, attempt);
    } catch (err) {
      const isRetryable =
        err.message.includes('timed out') ||
        err.message.includes('BlockhashNotFound') ||
        err.message.includes('block height exceeded');

      if (!isRetryable || attempt === SWAP_MAX_RETRIES) throw err;

      // Calculate bumped fee for next attempt
      if (currentFee === 'auto' || typeof currentFee !== 'number' || currentFee <= 0) {
        // First bump — use network estimate or default
        currentFee = networkFeeEstimate || DEFAULT_RETRY_FEE_LAMPORTS;
      } else {
        currentFee = Math.ceil(currentFee * FEE_BUMP_MULTIPLIER);
      }

      logger.warn(`Swap attempt ${attempt + 1} failed: ${err.message}`);
      logger.warn(`Retrying with priority fee: ${currentFee} lamports (attempt ${attempt + 2}/${SWAP_MAX_RETRIES + 1})...`);
    }
  }
}

module.exports = { getQuote, executeSwap };
