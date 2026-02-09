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
const { WBNB, USDT, USDC, BUSD } = require('../src/config');

const TARGET_ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const JUNK_ADDR = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

function makePool(overrides = {}) {
  return {
    dexId: 'pancakeswap',
    pairAddress: '0xPoolAddr123',
    baseToken: { symbol: 'TOKEN', address: TARGET_ADDR },
    quoteToken: { symbol: 'WBNB', address: WBNB },
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
    const result = identifyTokens(pool, TARGET_ADDR);
    expect(result.target.address).toBe(TARGET_ADDR);
    expect(result.quote.address).toBe(WBNB);
  });

  test('returns target=quote, quote=base when quote matches', () => {
    const pool = makePool({
      baseToken: { symbol: 'WBNB', address: WBNB },
      quoteToken: { symbol: 'TOKEN', address: TARGET_ADDR },
    });
    const result = identifyTokens(pool, TARGET_ADDR);
    expect(result.target.address).toBe(TARGET_ADDR);
    expect(result.quote.address).toBe(WBNB);
  });

  test('returns null when target not in pair', () => {
    const pool = makePool();
    expect(identifyTokens(pool, '0xnotInPair000000000000000000000000000000')).toBeNull();
  });

  test('handles case-insensitive address matching', () => {
    const pool = makePool({
      baseToken: { symbol: 'TOKEN', address: TARGET_ADDR.toUpperCase().replace('0X', '0x') },
    });
    const result = identifyTokens(pool, TARGET_ADDR.toLowerCase());
    expect(result).not.toBeNull();
  });
});

// === validatePool ===

describe('validatePool', () => {
  test('passes valid pool (base=target, quote=WBNB, trusted DEX)', () => {
    const pool = makePool();
    const result = validatePool(pool, TARGET_ADDR);
    expect(result.valid).toBe(true);
    expect(result.quoteInfo.symbol).toBe('WBNB');
  });

  test('passes pool with USDT as quote', () => {
    const pool = makePool({
      quoteToken: { symbol: 'USDT', address: USDT },
    });
    const result = validatePool(pool, TARGET_ADDR);
    expect(result.valid).toBe(true);
    expect(result.quoteInfo.symbol).toBe('USDT');
  });

  test('passes pool with BUSD as quote (tier 2)', () => {
    const pool = makePool({
      quoteToken: { symbol: 'BUSD', address: BUSD },
    });
    const result = validatePool(pool, TARGET_ADDR);
    expect(result.valid).toBe(true);
    expect(result.quoteInfo.tier).toBe(2);
  });

  test('rejects pool where target token is not in pair', () => {
    const pool = makePool({
      baseToken: { symbol: 'OTHER', address: '0xOther' },
    });
    const result = validatePool(pool, TARGET_ADDR);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('target token not in pair');
  });

  test('rejects pool with junk quote token', () => {
    const pool = makePool({
      quoteToken: { symbol: 'SCAM', address: JUNK_ADDR },
    });
    const result = validatePool(pool, TARGET_ADDR);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('non-liquid quote token');
  });

  test('rejects pool on untrusted DEX', () => {
    const pool = makePool({ dexId: 'unknownDex' });
    const result = validatePool(pool, TARGET_ADDR);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('untrusted DEX');
  });

  test('rejects pool with zero liquidity', () => {
    const pool = makePool({ liquidity: { usd: 0 } });
    const result = validatePool(pool, TARGET_ADDR);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('zero liquidity');
  });

  test('DEX matching is case-insensitive', () => {
    const pool = makePool({ dexId: 'PancakeSwap' });
    const result = validatePool(pool, TARGET_ADDR);
    expect(result.valid).toBe(true);
  });
});

// === scorePool ===

describe('scorePool', () => {
  const tier1 = { symbol: 'WBNB', tier: 1 };
  const tier2 = { symbol: 'BUSD', tier: 2 };

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
    expect(Math.abs(s.total - sum)).toBeLessThan(0.02);
  });

  test('scores zero for pool with no liquidity and no volume', () => {
    const pool = makePool({
      liquidity: { usd: 0 },
      volume: { h24: 0 },
      txns: undefined,
    });
    const s = scorePool(pool, tier1);
    expect(s.breakdown.liquidity).toBe(0);
    expect(s.breakdown.volume).toBe(0);
    expect(s.total).toBe(10); // only quoteQuality
  });
});

// === analyzePools ===

describe('analyzePools', () => {
  beforeEach(() => jest.clearAllMocks());

  test('selects best pool by composite score', () => {
    const pools = [
      makePool({ pairAddress: 'low-liq', liquidity: { usd: 1000 }, volume: { h24: 100 } }),
      makePool({ pairAddress: 'high-liq', liquidity: { usd: 500000 }, volume: { h24: 80000 } }),
      makePool({ pairAddress: 'mid-liq', liquidity: { usd: 50000 }, volume: { h24: 10000 } }),
    ];
    const best = analyzePools(pools, TARGET_ADDR);
    expect(best.pairAddress).toBe('high-liq');
  });

  test('filters out pools with junk quote tokens', () => {
    const pools = [
      makePool({
        pairAddress: 'junk-quote',
        quoteToken: { symbol: 'SCAM', address: JUNK_ADDR },
        liquidity: { usd: 999999 },
      }),
      makePool({ pairAddress: 'wbnb-quote', liquidity: { usd: 5000 } }),
    ];
    const best = analyzePools(pools, TARGET_ADDR);
    expect(best.pairAddress).toBe('wbnb-quote');
  });

  test('filters out pools from untrusted DEXes', () => {
    const pools = [
      makePool({ pairAddress: 'untrusted', dexId: 'scamDex', liquidity: { usd: 999999 } }),
      makePool({ pairAddress: 'trusted', dexId: 'pancakeswap', liquidity: { usd: 5000 } }),
    ];
    const best = analyzePools(pools, TARGET_ADDR);
    expect(best.pairAddress).toBe('trusted');
  });

  test('returns undefined when no pools pass filters', () => {
    const pools = [
      makePool({ dexId: 'scamDex' }),
      makePool({ quoteToken: { symbol: 'JUNK', address: JUNK_ADDR } }),
    ];
    const best = analyzePools(pools, TARGET_ADDR);
    expect(best).toBeUndefined();
  });

  test('returns undefined for empty array', () => {
    const best = analyzePools([], TARGET_ADDR);
    expect(best).toBeUndefined();
  });

  test('handles single valid pool', () => {
    const pools = [makePool({ pairAddress: 'only' })];
    const best = analyzePools(pools, TARGET_ADDR);
    expect(best.pairAddress).toBe('only');
  });
});
