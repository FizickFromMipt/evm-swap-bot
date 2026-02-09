const logger = require('./logger');

// --- Known liquid quote tokens on Solana ---
const LIQUID_QUOTES = {
  So11111111111111111111111111111111111111112: { symbol: 'SOL', tier: 1 },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', tier: 1 },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', tier: 2 },
};

// --- Trusted DEXes on Solana ---
const TRUSTED_DEXES = new Set([
  'raydium',
  'orca',
  'meteora',
  'phoenix',
  'lifinity',
  'openbook',
  'fluxbeam',
  'invariant',
  'saber',
]);

/**
 * Identify which token in the pair is the target and which is the quote.
 * Returns { target, quote } with the pool's token objects, or null if
 * the target mint is not found in the pair.
 */
function identifyTokens(pool, targetMint) {
  const base = pool.baseToken;
  const quote = pool.quoteToken;

  if (base?.address === targetMint) return { target: base, quote };
  if (quote?.address === targetMint) return { target: quote, quote: base };
  return null;
}

/**
 * Hard filters — pool MUST pass all of these or it's discarded.
 * Returns { valid: true, tokens, quoteInfo } or { valid: false, reason }.
 */
function validatePool(pool, targetMint) {
  // 1. Token address must match
  const tokens = identifyTokens(pool, targetMint);
  if (!tokens) {
    return { valid: false, reason: 'target token not in pair' };
  }

  // 2. Quote token must be liquid (SOL / USDC / USDT)
  const quoteAddr = tokens.quote?.address;
  const quoteInfo = LIQUID_QUOTES[quoteAddr];
  if (!quoteInfo) {
    return { valid: false, reason: `non-liquid quote token: ${tokens.quote?.symbol || quoteAddr}` };
  }

  // 3. DEX must be trusted
  const dexId = (pool.dexId || '').toLowerCase();
  if (!TRUSTED_DEXES.has(dexId)) {
    return { valid: false, reason: `untrusted DEX: ${pool.dexId}` };
  }

  // 4. Must have non-zero liquidity
  const liq = pool.liquidity?.usd || 0;
  if (liq <= 0) {
    return { valid: false, reason: 'zero liquidity' };
  }

  return { valid: true, tokens, quoteInfo };
}

/**
 * Composite scoring (0–100 scale).
 *
 * - Liquidity:      40 pts max (log10 scale, $1K → 12pts, $100K → 20pts, $1M → 40pts)
 * - Volume 24h:     25 pts max (log10 scale)
 * - Turnover ratio: 15 pts max (volume/liquidity ratio, capped at 2.0)
 * - Quote quality:  10 pts max (tier 1 = 10, tier 2 = 5)
 * - Tx count 24h:   10 pts max (log10 scale, capped)
 */
function scorePool(pool, quoteInfo) {
  const liq = pool.liquidity?.usd || 0;
  const vol = pool.volume?.h24 || 0;
  const txCount = pool.txns?.h24?.buys + pool.txns?.h24?.sells || 0;

  // Log-scale helper: maps value to 0–maxPts range using log10
  const logScore = (value, maxPts, low, high) => {
    if (value <= 0) return 0;
    const log = Math.log10(value);
    const logLow = Math.log10(low);
    const logHigh = Math.log10(high);
    return Math.min(maxPts, Math.max(0, ((log - logLow) / (logHigh - logLow)) * maxPts));
  };

  const liqScore = logScore(liq, 40, 1_000, 1_000_000);
  const volScore = logScore(vol, 25, 100, 500_000);

  // Turnover: vol/liq — higher is better (active pool), capped at 2.0
  const turnover = liq > 0 ? Math.min(vol / liq, 2.0) : 0;
  const turnoverScore = (turnover / 2.0) * 15;

  // Quote quality: tier 1 = 10, tier 2 = 5
  const quoteScore = quoteInfo.tier === 1 ? 10 : 5;

  // Transaction count score
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
 * Applies hard filters (token match, liquid quote, trusted DEX), then
 * composite scoring (liquidity + volume + turnover + quote quality + activity).
 *
 * This is purely informational — Jupiter handles actual routing.
 * Returns the best pool or undefined.
 */
function analyzePools(pools, tokenMint) {
  logger.step('Analyzing DexScreener pools...');
  logger.sep();

  if (pools.length === 0) {
    logger.warn('No pools found on DexScreener for this token.');
    return undefined;
  }

  logger.info(`Total pools from DexScreener: ${pools.length}`);

  // --- Filter ---
  const valid = [];
  const rejected = { total: 0, reasons: {} };

  for (const pool of pools) {
    const result = validatePool(pool, tokenMint);
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

  // --- Score & rank ---
  const scored = valid.map(({ pool, quoteInfo, tokens }) => ({
    pool,
    tokens,
    quoteInfo,
    score: scorePool(pool, quoteInfo),
  }));

  scored.sort((a, b) => b.score.total - a.score.total);

  // --- Log pools ---
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

  // --- DEX summary ---
  const dexSummary = {};
  for (const { pool } of scored) {
    if (!dexSummary[pool.dexId]) dexSummary[pool.dexId] = { count: 0, totalLiq: 0 };
    dexSummary[pool.dexId].count++;
    dexSummary[pool.dexId].totalLiq += pool.liquidity?.usd || 0;
  }
  logger.info('DEX summary (qualified pools only):');
  for (const [dex, info] of Object.entries(dexSummary)) {
    logger.info(`  ${dex}: ${info.count} pool(s), total liquidity $${info.totalLiq.toLocaleString()}`);
  }

  // --- Best pool ---
  const best = scored[0];
  const liq = best.pool.liquidity?.usd
    ? `$${Number(best.pool.liquidity.usd).toLocaleString()}`
    : 'N/A';
  const pair = `${best.pool.baseToken.symbol}/${best.pool.quoteToken.symbol}`;
  logger.sep();
  const labels = best.pool.labels?.length ? best.pool.labels.join(', ') : 'N/A';
  logger.success(`Best pool: ${pair} on ${best.pool.dexId} (score: ${best.score.total}/100)`);
  logger.info(`  Liquidity: ${liq}`);
  logger.info(`  Pool: ${best.pool.pairAddress}`);
  logger.info(`  Pool type/labels: ${labels}`);
  logger.info(`  Price USD: $${best.pool.priceUsd || 'N/A'}`);
  logger.info(`  Quote token: ${best.quoteInfo.symbol} (tier ${best.quoteInfo.tier})`);
  logger.sep();

  logger.info('Note: Jupiter aggregator will find the optimal route independently.');
  logger.info('DexScreener data above is for reference only.');
  logger.sep();

  return best.pool;
}

module.exports = {
  analyzePools,
  // Exported for testing
  identifyTokens,
  validatePool,
  scorePool,
  LIQUID_QUOTES,
  TRUSTED_DEXES,
};
