const logger = require('./logger');
const { WBNB, USDT, USDC, BUSD } = require('./config');

// --- Known liquid quote tokens on BSC ---
const LIQUID_QUOTES = {
  [WBNB.toLowerCase()]: { symbol: 'WBNB', tier: 1 },
  [USDT.toLowerCase()]: { symbol: 'USDT', tier: 1 },
  [USDC.toLowerCase()]: { symbol: 'USDC', tier: 1 },
  [BUSD.toLowerCase()]: { symbol: 'BUSD', tier: 2 },
};

// --- Trusted DEXes on BSC (V2, V3, V4 and other major protocols) ---
const TRUSTED_DEXES = new Set([
  'pancakeswap',
  'pancakeswap-v3',
  'pancakeswap-v4',
  'biswap',
  'biswap-v3',
  'uniswap-v3',
  'uniswap-v4',
  'sushiswap',
  'sushiswap-v3',
  'thena',
  'thena-v3',
  'dodo',
  'apeswap',
  'mdex',
  'bakeryswap',
  'ellipsis',
  'wombat',
]);

/**
 * Identify which token in the pair is the target and which is the quote.
 */
function identifyTokens(pool, targetAddress) {
  const base = pool.baseToken;
  const quote = pool.quoteToken;
  const target = targetAddress.toLowerCase();

  if (base?.address?.toLowerCase() === target) return { target: base, quote };
  if (quote?.address?.toLowerCase() === target) return { target: quote, quote: base };
  return null;
}

/**
 * Hard filters — pool MUST pass all of these or it's discarded.
 */
function validatePool(pool, targetAddress) {
  const tokens = identifyTokens(pool, targetAddress);
  if (!tokens) {
    return { valid: false, reason: 'target token not in pair' };
  }

  const quoteAddr = tokens.quote?.address?.toLowerCase();
  const quoteInfo = quoteAddr ? LIQUID_QUOTES[quoteAddr] : undefined;
  if (!quoteInfo) {
    return { valid: false, reason: `non-liquid quote token: ${tokens.quote?.symbol || quoteAddr}` };
  }

  const dexId = (pool.dexId || '').toLowerCase();
  if (!TRUSTED_DEXES.has(dexId)) {
    return { valid: false, reason: `untrusted DEX: ${pool.dexId}` };
  }

  const liq = pool.liquidity?.usd || 0;
  if (liq <= 0) {
    return { valid: false, reason: 'zero liquidity' };
  }

  return { valid: true, tokens, quoteInfo };
}

/**
 * Composite scoring (0-100 scale).
 */
function scorePool(pool, quoteInfo) {
  const liq = pool.liquidity?.usd || 0;
  const vol = pool.volume?.h24 || 0;
  const txCount = (pool.txns?.h24?.buys || 0) + (pool.txns?.h24?.sells || 0);

  const logScore = (value, maxPts, low, high) => {
    if (value <= 0) return 0;
    const log = Math.log10(value);
    const logLow = Math.log10(low);
    const logHigh = Math.log10(high);
    return Math.min(maxPts, Math.max(0, ((log - logLow) / (logHigh - logLow)) * maxPts));
  };

  const liqScore = logScore(liq, 40, 1_000, 1_000_000);
  const volScore = logScore(vol, 25, 100, 500_000);

  const turnover = liq > 0 ? Math.min(vol / liq, 2.0) : 0;
  const turnoverScore = (turnover / 2.0) * 15;

  const quoteScore = quoteInfo.tier === 1 ? 10 : 5;
  const txScore = logScore(txCount, 10, 10, 10_000);

  const total = liqScore + volScore + turnoverScore + quoteScore + txScore;

  return {
    total: Math.round(total * 100) / 100,
    breakdown: {
      liquidity: Math.round(liqScore * 100) / 100,
      volume: Math.round(volScore * 100) / 100,
      turnover: Math.round(turnoverScore * 100) / 100,
      quoteQuality: quoteScore,
      txActivity: Math.round(txScore * 100) / 100,
    },
  };
}

/**
 * Analyze and rank pools from DexScreener.
 * Returns the best pool or undefined.
 */
function analyzePools(pools, targetAddress) {
  logger.step('Analyzing DexScreener pools...');
  logger.sep();

  if (pools.length === 0) {
    logger.warn('No pools found on DexScreener for this token.');
    return undefined;
  }

  logger.info(`Total pools from DexScreener: ${pools.length}`);

  const valid = [];
  const rejected = { total: 0, reasons: {} };

  for (const pool of pools) {
    const result = validatePool(pool, targetAddress);
    if (result.valid) {
      valid.push({ pool, quoteInfo: result.quoteInfo, tokens: result.tokens });
    } else {
      rejected.total++;
      rejected.reasons[result.reason] = (rejected.reasons[result.reason] || 0) + 1;
    }
  }

  if (rejected.total > 0) {
    logger.info(`Filtered out ${rejected.total} pool(s):`);
    for (const [reason, count] of Object.entries(rejected.reasons)) {
      logger.info(`  - ${reason}: ${count}`);
    }
  }

  if (valid.length === 0) {
    logger.warn('No pools passed filters. Token may lack liquid pairs on trusted DEXes.');
    logger.sep();
    return undefined;
  }

  logger.info(`Qualified pools: ${valid.length}`);
  logger.sep();

  const scored = valid.map(({ pool, quoteInfo, tokens }) => ({
    pool,
    tokens,
    quoteInfo,
    score: scorePool(pool, quoteInfo),
  }));

  scored.sort((a, b) => b.score.total - a.score.total);

  scored.forEach(({ pool, score }, i) => {
    logger.pool(i, pool);
    logger.info(
      `  Score: ${score.total}/100 ` +
        `(liq=${score.breakdown.liquidity} vol=${score.breakdown.volume} ` +
        `turn=${score.breakdown.turnover} quote=${score.breakdown.quoteQuality} ` +
        `tx=${score.breakdown.txActivity})`
    );
  });
  logger.sep();

  const best = scored[0];
  const liq = best.pool.liquidity?.usd
    ? `$${Number(best.pool.liquidity.usd).toLocaleString()}`
    : 'N/A';
  const pair = `${best.pool.baseToken.symbol}/${best.pool.quoteToken.symbol}`;
  logger.sep();
  logger.success(`Best pool: ${pair} on ${best.pool.dexId} (score: ${best.score.total}/100)`);
  logger.info(`  Liquidity: ${liq}`);
  logger.info(`  Pool: ${best.pool.pairAddress}`);
  logger.info(`  Quote token: ${best.quoteInfo.symbol} (tier ${best.quoteInfo.tier})`);
  logger.sep();

  return best.pool;
}

module.exports = {
  analyzePools,
  identifyTokens,
  validatePool,
  scorePool,
  LIQUID_QUOTES,
  TRUSTED_DEXES,
};
