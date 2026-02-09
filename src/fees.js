const logger = require('./logger');

// Typical swap uses 200K-400K compute units; 300K is a safe average
const ESTIMATED_SWAP_CU = 300_000;

/**
 * Convert micro-lamports per compute unit to total lamports.
 */
function microLamportsToLamports(microLamports, cu = ESTIMATED_SWAP_CU) {
  return Math.ceil(microLamports * cu / 1_000_000);
}

/**
 * Estimate priority fees based on recent network activity.
 * Uses getRecentPrioritizationFees RPC method.
 *
 * Returns { low, medium, high } in total lamports (for ~300K CU swap),
 * or null if estimation fails.
 */
async function estimatePriorityFee(connection) {
  logger.step('Estimating network priority fees...');

  try {
    const recentFees = await connection.getRecentPrioritizationFees();

    if (!recentFees || recentFees.length === 0) {
      logger.info('No recent fee data available');
      return null;
    }

    const nonZero = recentFees
      .map((f) => f.prioritizationFee)
      .filter((f) => f > 0)
      .sort((a, b) => a - b);

    if (nonZero.length === 0) {
      logger.info('Network is not congested (all recent priority fees are 0)');
      return { low: 0, medium: 0, high: 0, sampledSlots: recentFees.length };
    }

    const percentile = (arr, pct) => arr[Math.min(Math.floor(arr.length * pct / 100), arr.length - 1)];

    const p25 = percentile(nonZero, 25);
    const p50 = percentile(nonZero, 50);
    const p75 = percentile(nonZero, 75);

    const result = {
      low: microLamportsToLamports(p25),
      medium: microLamportsToLamports(p50),
      high: microLamportsToLamports(p75),
      sampledSlots: recentFees.length,
    };

    logger.info(`Priority fees (${nonZero.length} non-zero / ${recentFees.length} slots):`);
    logger.info(`  Low (p25):    ${result.low} lamports (${p25} \u00B5L/CU)`);
    logger.info(`  Medium (p50): ${result.medium} lamports (${p50} \u00B5L/CU)`);
    logger.info(`  High (p75):   ${result.high} lamports (${p75} \u00B5L/CU)`);

    return result;
  } catch (err) {
    logger.warn(`Fee estimation failed: ${err.message}`);
    return null;
  }
}

module.exports = { estimatePriorityFee, microLamportsToLamports, ESTIMATED_SWAP_CU };
