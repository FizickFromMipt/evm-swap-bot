jest.mock('../src/logger', () => ({
  step: jest.fn(),
  sep: jest.fn(),
  pool: jest.fn(),
  info: jest.fn(),
  success: jest.fn(),
  warn: jest.fn(),
}));

const {
  analyzePools,
  identifyTokens,
  validatePool,
  scorePool,
  LIQUID_QUOTES,
  TRUSTED_DEXES,
} = require('../src/poolSelector');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const TARGET_MINT = 'TargetTokenMint111111111111111111111111111';
const JUNK_MINT = 'JunkTokenMint1111111111111111111111111111';

function makePool(overrides = {}) {
  return {
    dexId: 'raydium',
    pairAddress: 'poolAddr123',
    baseToken: { symbol: 'TOKEN', address: TARGET_MINT },
    quoteToken: { symbol: 'SOL', address: SOL_MINT },
    liquidity: { usd: 50000 },
    volume: { h24: 10000 },
    txns: { h24: { buys: 100, sells: 80 } },
    priceUsd: '0.01',
    ...overrides,
  };
}

// === identifyTokens ===

describe('identifyTokens', () => {
  test('returns target=base, quote=quote when base matches', () => {
    const pool = makePool();
    const result = identifyTokens(pool, TARGET_MINT);
    expect(result.target.address).toBe(TARGET_MINT);
    expect(result.quote.address).toBe(SOL_MINT);
  });

  test('returns target=quote, quote=base when quote matches', () => {
    const pool = makePool({
      baseToken: { symbol: 'SOL', address: SOL_MINT },
      quoteToken: { symbol: 'TOKEN', address: TARGET_MINT },
    });
    const result = identifyTokens(pool, TARGET_MINT);
    expect(result.target.address).toBe(TARGET_MINT);
    expect(result.quote.address).toBe(SOL_MINT);
  });

  test('returns null when target not in pair', () => {
    const pool = makePool();
    expect(identifyTokens(pool, 'SomeOtherMint')).toBeNull();
  });

  test('handles pool with missing baseToken', () => {
    const pool = makePool({ baseToken: undefined });
    expect(identifyTokens(pool, TARGET_MINT)).toBeNull();
  });
});

// === validatePool ===

describe('validatePool', () => {
  test('passes valid pool (base=target, quote=SOL, trusted DEX)', () => {
    const pool = makePool();
    const result = validatePool(pool, TARGET_MINT);
    expect(result.valid).toBe(true);
    expect(result.quoteInfo.symbol).toBe('SOL');
  });

  test('passes pool with USDC as quote', () => {
    const pool = makePool({
      quoteToken: { symbol: 'USDC', address: USDC_MINT },
    });
    const result = validatePool(pool, TARGET_MINT);
    expect(result.valid).toBe(true);
    expect(result.quoteInfo.symbol).toBe('USDC');
  });

  test('passes pool with USDT as quote (tier 2)', () => {
    const pool = makePool({
      quoteToken: { symbol: 'USDT', address: USDT_MINT },
    });
    const result = validatePool(pool, TARGET_MINT);
    expect(result.valid).toBe(true);
    expect(result.quoteInfo.tier).toBe(2);
  });

  test('rejects pool where target token is not in pair', () => {
    const pool = makePool({
      baseToken: { symbol: 'OTHER', address: 'OtherMint' },
    });
    const result = validatePool(pool, TARGET_MINT);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('target token not in pair');
  });

  test('rejects pool with junk quote token', () => {
    const pool = makePool({
      quoteToken: { symbol: 'SCAM', address: JUNK_MINT },
    });
    const result = validatePool(pool, TARGET_MINT);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('non-liquid quote token');
  });

  test('rejects pool on untrusted DEX', () => {
    const pool = makePool({ dexId: 'unknownDex' });
    const result = validatePool(pool, TARGET_MINT);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('untrusted DEX');
  });

  test('rejects pool with zero liquidity', () => {
    const pool = makePool({ liquidity: { usd: 0 } });
    const result = validatePool(pool, TARGET_MINT);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('zero liquidity');
  });

  test('rejects pool with undefined liquidity', () => {
    const pool = makePool({ liquidity: undefined });
    const result = validatePool(pool, TARGET_MINT);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('zero liquidity');
  });

  test('DEX matching is case-insensitive', () => {
    const pool = makePool({ dexId: 'Raydium' });
    const result = validatePool(pool, TARGET_MINT);
    expect(result.valid).toBe(true);
  });
});

// === scorePool ===

describe('scorePool', () => {
  const tier1 = { symbol: 'SOL', tier: 1 };
  const tier2 = { symbol: 'USDT', tier: 2 };

  test('gives higher score to pool with more liquidity', () => {
    const low = makePool({ liquidity: { usd: 5000 }, volume: { h24: 1000 } });
    const high = makePool({ liquidity: { usd: 500000 }, volume: { h24: 1000 } });

    const scoreLow = scorePool(low, tier1);
    const scoreHigh = scorePool(high, tier1);

    expect(scoreHigh.total).toBeGreaterThan(scoreLow.total);
  });

  test('gives higher score to pool with more volume', () => {
    const lowVol = makePool({ liquidity: { usd: 50000 }, volume: { h24: 100 } });
    const highVol = makePool({ liquidity: { usd: 50000 }, volume: { h24: 100000 } });

    const scoreLow = scorePool(lowVol, tier1);
    const scoreHigh = scorePool(highVol, tier1);

    expect(scoreHigh.total).toBeGreaterThan(scoreLow.total);
  });

  test('tier 1 quote gives higher score than tier 2', () => {
    const pool = makePool({ liquidity: { usd: 50000 }, volume: { h24: 10000 } });

    const s1 = scorePool(pool, tier1);
    const s2 = scorePool(pool, tier2);

    expect(s1.total).toBeGreaterThan(s2.total);
    expect(s1.breakdown.quoteQuality).toBe(10);
    expect(s2.breakdown.quoteQuality).toBe(5);
  });

  test('includes turnover ratio in score', () => {
    // High turnover: volume = 2x liquidity
    const active = makePool({ liquidity: { usd: 10000 }, volume: { h24: 20000 } });
    // Low turnover: volume = 0.01x liquidity
    const stale = makePool({ liquidity: { usd: 10000 }, volume: { h24: 100 } });

    const sActive = scorePool(active, tier1);
    const sStale = scorePool(stale, tier1);

    expect(sActive.breakdown.turnover).toBeGreaterThan(sStale.breakdown.turnover);
  });

  test('scores zero for pool with no liquidity and no volume', () => {
    const pool = makePool({
      liquidity: { usd: 0 },
      volume: { h24: 0 },
      txns: undefined,
    });

    const s = scorePool(pool, tier1);
    // Only quoteQuality (10) should be nonzero
    expect(s.breakdown.liquidity).toBe(0);
    expect(s.breakdown.volume).toBe(0);
    expect(s.breakdown.turnover).toBe(0);
    expect(s.breakdown.txActivity).toBe(0);
    expect(s.total).toBe(10);
  });

  test('score breakdown adds up to total', () => {
    const pool = makePool({
      liquidity: { usd: 100000 },
      volume: { h24: 50000 },
      txns: { h24: { buys: 200, sells: 150 } },
    });
    const s = scorePool(pool, tier1);
    const sum =
      s.breakdown.liquidity +
      s.breakdown.volume +
      s.breakdown.turnover +
      s.breakdown.quoteQuality +
      s.breakdown.txActivity;

    expect(Math.abs(s.total - sum)).toBeLessThan(0.02); // rounding tolerance
  });

  test('caps turnover at 2.0', () => {
    // Volume 100x liquidity — turnover should still cap at 15 pts
    const pool = makePool({ liquidity: { usd: 1000 }, volume: { h24: 100000 } });
    const s = scorePool(pool, tier1);
    expect(s.breakdown.turnover).toBe(15);
  });
});

// === analyzePools (integration) ===

describe('analyzePools', () => {
  beforeEach(() => jest.clearAllMocks());

  test('selects best pool by composite score', () => {
    const pools = [
      makePool({
        pairAddress: 'low-liq',
        liquidity: { usd: 1000 },
        volume: { h24: 100 },
      }),
      makePool({
        pairAddress: 'high-liq',
        liquidity: { usd: 500000 },
        volume: { h24: 80000 },
      }),
      makePool({
        pairAddress: 'mid-liq',
        liquidity: { usd: 50000 },
        volume: { h24: 10000 },
      }),
    ];

    const best = analyzePools(pools, TARGET_MINT);
    expect(best.pairAddress).toBe('high-liq');
  });

  test('filters out pools with junk quote tokens', () => {
    const pools = [
      makePool({
        pairAddress: 'junk-quote',
        quoteToken: { symbol: 'SCAM', address: JUNK_MINT },
        liquidity: { usd: 999999 },
      }),
      makePool({
        pairAddress: 'sol-quote',
        liquidity: { usd: 5000 },
      }),
    ];

    const best = analyzePools(pools, TARGET_MINT);
    expect(best.pairAddress).toBe('sol-quote');
  });

  test('filters out pools from untrusted DEXes', () => {
    const pools = [
      makePool({ pairAddress: 'untrusted', dexId: 'scamDex', liquidity: { usd: 999999 } }),
      makePool({ pairAddress: 'trusted', dexId: 'orca', liquidity: { usd: 5000 } }),
    ];

    const best = analyzePools(pools, TARGET_MINT);
    expect(best.pairAddress).toBe('trusted');
  });

  test('filters out pools where target token is not in the pair', () => {
    const pools = [
      makePool({
        pairAddress: 'wrong-token',
        baseToken: { symbol: 'OTHER', address: 'WrongMint123' },
        liquidity: { usd: 999999 },
      }),
      makePool({ pairAddress: 'correct', liquidity: { usd: 5000 } }),
    ];

    const best = analyzePools(pools, TARGET_MINT);
    expect(best.pairAddress).toBe('correct');
  });

  test('returns undefined when no pools pass filters', () => {
    const pools = [
      makePool({ dexId: 'scamDex' }),
      makePool({ quoteToken: { symbol: 'JUNK', address: JUNK_MINT } }),
    ];

    const best = analyzePools(pools, TARGET_MINT);
    expect(best).toBeUndefined();
  });

  test('returns undefined for empty array', () => {
    const best = analyzePools([], TARGET_MINT);
    expect(best).toBeUndefined();
  });

  test('handles single valid pool', () => {
    const pools = [makePool({ pairAddress: 'only' })];
    const best = analyzePools(pools, TARGET_MINT);
    expect(best.pairAddress).toBe('only');
  });

  test('prefers SOL quote (tier 1) over USDT quote (tier 2) when liquidity is similar', () => {
    const pools = [
      makePool({
        pairAddress: 'usdt-pool',
        quoteToken: { symbol: 'USDT', address: USDT_MINT },
        liquidity: { usd: 50000 },
        volume: { h24: 10000 },
      }),
      makePool({
        pairAddress: 'sol-pool',
        quoteToken: { symbol: 'SOL', address: SOL_MINT },
        liquidity: { usd: 50000 },
        volume: { h24: 10000 },
      }),
    ];

    const best = analyzePools(pools, TARGET_MINT);
    expect(best.pairAddress).toBe('sol-pool');
  });

  test('handles pool with target as quoteToken (reversed pair)', () => {
    const pools = [
      makePool({
        pairAddress: 'reversed',
        baseToken: { symbol: 'SOL', address: SOL_MINT },
        quoteToken: { symbol: 'TOKEN', address: TARGET_MINT },
        liquidity: { usd: 50000 },
      }),
    ];

    const best = analyzePools(pools, TARGET_MINT);
    expect(best.pairAddress).toBe('reversed');
  });

  test('all pools filtered logs warning', () => {
    const logger = require('../src/logger');
    analyzePools([makePool({ dexId: 'fakeDex' })], TARGET_MINT);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('No pools passed filters')
    );
  });
});
