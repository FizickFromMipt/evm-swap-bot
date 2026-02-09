const { client } = require('./http');
const { withRetry } = require('./retry');
const logger = require('./logger');

/**
 * Fetch all Solana pools for a given token mint from DexScreener.
 */
async function fetchPools(apiUrl, tokenMint) {
  logger.step(`Fetching pools from DexScreener for: ${tokenMint}`);

  const url = `${apiUrl}/${tokenMint}`;
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

  const solanaPairs = data.pairs.filter((p) => p.chainId === 'solana');
  logger.info(`Solana pairs: ${solanaPairs.length}`);

  if (solanaPairs.length === 0) {
    const chains = [...new Set(data.pairs.map((p) => p.chainId))];
    throw new Error(`No Solana pools found. Available chains: ${chains.join(', ') || 'none'}`);
  }

  return solanaPairs;
}

module.exports = { fetchPools };
