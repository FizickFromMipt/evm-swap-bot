const { client } = require('./http');
const { withRetry } = require('./retry');
const logger = require('./logger');

/**
 * Fetch all BSC pools for a given token address from DexScreener.
 */
async function fetchPools(apiUrl, tokenAddress) {
  logger.step(`Fetching pools from DexScreener for: ${tokenAddress}`);

  const url = `${apiUrl}/${tokenAddress}`;
  logger.info(`API: ${url}`);

  const { data } = await withRetry(
    () => client.get(url, { timeout: 15000 }),
    {
      retries: 3,
      baseDelay: 1000,
      onRetry: (attempt, delay) =>
        logger.warn(`DexScreener request failed, retry #${attempt} in ${delay}ms...`),
    }
  );

  if (!data || !data.pairs) {
    throw new Error('DexScreener returned no pairs. Token may not be listed.');
  }

  logger.info(`Total pairs from DexScreener: ${data.pairs.length}`);

  const bscPairs = data.pairs.filter((p) => p.chainId === 'bsc');
  logger.info(`BSC pairs: ${bscPairs.length}`);

  if (bscPairs.length === 0) {
    const chains = [...new Set(data.pairs.map((p) => p.chainId))];
    throw new Error(`No BSC pools found. Available chains: ${chains.join(', ') || 'none'}`);
  }

  return bscPairs;
}

module.exports = { fetchPools };
