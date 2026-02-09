jest.mock('../src/logger', () => ({
  step: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  success: jest.fn(),
  sep: jest.fn(),
}));

const { estimatePriorityFee, microLamportsToLamports, ESTIMATED_SWAP_CU } = require('../src/fees');

describe('microLamportsToLamports', () => {
  test('converts with default CU (300K)', () => {
    // 1000 micro-lamports/CU * 300,000 CU / 1,000,000 = 300 lamports
    expect(microLamportsToLamports(1000)).toBe(300);
  });

  test('converts with custom CU', () => {
    expect(microLamportsToLamports(1000, 200_000)).toBe(200);
  });

  test('rounds up (ceil)', () => {
    // 1 micro-lamport/CU * 300,000 CU / 1,000,000 = 0.3 → ceil = 1
    expect(microLamportsToLamports(1)).toBe(1);
  });

  test('returns 0 for 0 input', () => {
    expect(microLamportsToLamports(0)).toBe(0);
  });
});

describe('estimatePriorityFee', () => {
  test('returns percentiles from recent fees', async () => {
    const fees = [
      { slot: 1, prioritizationFee: 0 },
      { slot: 2, prioritizationFee: 100 },
      { slot: 3, prioritizationFee: 500 },
      { slot: 4, prioritizationFee: 1000 },
      { slot: 5, prioritizationFee: 2000 },
      { slot: 6, prioritizationFee: 5000 },
      { slot: 7, prioritizationFee: 10000 },
      { slot: 8, prioritizationFee: 0 },
    ];

    const conn = { getRecentPrioritizationFees: jest.fn().mockResolvedValue(fees) };
    const result = await estimatePriorityFee(conn);

    expect(result).not.toBeNull();
    expect(result.low).toBeGreaterThan(0);
    expect(result.medium).toBeGreaterThan(result.low);
    expect(result.high).toBeGreaterThanOrEqual(result.medium);
    expect(result.sampledSlots).toBe(8);
  });

  test('returns zeros when all fees are 0', async () => {
    const fees = [
      { slot: 1, prioritizationFee: 0 },
      { slot: 2, prioritizationFee: 0 },
      { slot: 3, prioritizationFee: 0 },
    ];

    const conn = { getRecentPrioritizationFees: jest.fn().mockResolvedValue(fees) };
    const result = await estimatePriorityFee(conn);

    expect(result.low).toBe(0);
    expect(result.medium).toBe(0);
    expect(result.high).toBe(0);
  });

  test('returns null when no data available', async () => {
    const conn = { getRecentPrioritizationFees: jest.fn().mockResolvedValue([]) };
    const result = await estimatePriorityFee(conn);
    expect(result).toBeNull();
  });

  test('returns null when response is null', async () => {
    const conn = { getRecentPrioritizationFees: jest.fn().mockResolvedValue(null) };
    const result = await estimatePriorityFee(conn);
    expect(result).toBeNull();
  });

  test('returns null on RPC error (graceful fallback)', async () => {
    const conn = {
      getRecentPrioritizationFees: jest.fn().mockRejectedValue(new Error('RPC error')),
    };
    const result = await estimatePriorityFee(conn);
    expect(result).toBeNull();
  });

  test('handles single non-zero fee', async () => {
    const fees = [{ slot: 1, prioritizationFee: 5000 }];
    const conn = { getRecentPrioritizationFees: jest.fn().mockResolvedValue(fees) };
    const result = await estimatePriorityFee(conn);

    expect(result.low).toBe(microLamportsToLamports(5000));
    expect(result.medium).toBe(microLamportsToLamports(5000));
    expect(result.high).toBe(microLamportsToLamports(5000));
  });
});
