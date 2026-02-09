jest.mock('../src/http', () => ({
  client: { get: jest.fn(), post: jest.fn() },
  httpsAgent: {},
  httpAgent: {},
}));

jest.mock('../src/logger', () => ({
  step: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  sep: jest.fn(),
  route: jest.fn(),
}));

const { Keypair } = require('@solana/web3.js');
const { client } = require('../src/http');
const logger = require('../src/logger');
const { getQuote, executeSwap } = require('../src/jupiter');

const testKeypair = Keypair.generate();

const baseConfig = {
  solMint: 'So11111111111111111111111111111111111111112',
  jupiterApi: {
    quote: 'https://quote-api.jup.ag/v6/quote',
    swap: 'https://quote-api.jup.ag/v6/swap',
  },
  buyAmountSol: '0.01',
  amountLamports: 10_000_000,
  slippageBps: 500,
  priorityFee: 'auto',
  keypair: testKeypair,
};

// --- getQuote tests ---

describe('getQuote', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns quote data on success', async () => {
    const mockQuote = {
      outAmount: '1000000',
      otherAmountThreshold: '950000',
      priceImpactPct: '0.5',
      swapMode: 'ExactIn',
      routePlan: [
        { swapInfo: { label: 'Raydium', inAmount: '10000000', outAmount: '1000000' }, percent: 100 },
      ],
    };

    client.get.mockResolvedValue({ data: mockQuote });

    const result = await getQuote(baseConfig, 'tokenMint');
    expect(result.outAmount).toBe('1000000');
    expect(result.otherAmountThreshold).toBe('950000');
  });

  test('passes correct query params', async () => {
    client.get.mockResolvedValue({
      data: { outAmount: '100', otherAmountThreshold: '95', routePlan: [] },
    });

    await getQuote(baseConfig, 'myTokenMint');

    expect(client.get).toHaveBeenCalledWith(
      'https://quote-api.jup.ag/v6/quote',
      expect.objectContaining({
        params: {
          inputMint: 'So11111111111111111111111111111111111111112',
          outputMint: 'myTokenMint',
          amount: 10_000_000,
          slippageBps: 500,
        },
      })
    );
  });

  test('throws when outAmount is missing', async () => {
    client.get.mockResolvedValue({ data: { otherAmountThreshold: '0' } });
    await expect(getQuote(baseConfig, 'mint')).rejects.toThrow('no quote');
  });

  test('throws when data is empty', async () => {
    client.get.mockResolvedValue({ data: {} });
    await expect(getQuote(baseConfig, 'mint')).rejects.toThrow('no quote');
  });

  test('throws when data is null', async () => {
    client.get.mockResolvedValue({ data: null });
    await expect(getQuote(baseConfig, 'mint')).rejects.toThrow();
  });
});

// --- executeSwap tests ---

// Helper: build a minimal valid VersionedTransaction, serialize to base64
function buildMockSwapTx() {
  const { VersionedTransaction, MessageV0 } = require('@solana/web3.js');
  const msg = MessageV0.compile({
    payerKey: testKeypair.publicKey,
    instructions: [],
    recentBlockhash: 'GHtXQBsoZHVnNFa9YhV6xcu1GjQx3TQ91DP9avYQgxba',
  });
  const tx = new VersionedTransaction(msg);
  return Buffer.from(tx.serialize()).toString('base64');
}

function mockConnection(overrides = {}) {
  return {
    getLatestBlockhash: jest.fn().mockResolvedValue({
      blockhash: 'GHtXQBsoZHVnNFa9YhV6xcu1GjQx3TQ91DP9avYQgxba',
      lastValidBlockHeight: 100000,
    }),
    sendRawTransaction: jest.fn().mockResolvedValue('mockTxSignature123'),
    confirmTransaction: jest.fn().mockResolvedValue({ value: { err: null } }),
    getTransaction: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('executeSwap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('sends transaction and returns signature', async () => {
    const mockTxBase64 = buildMockSwapTx();
    client.post.mockResolvedValue({ data: { swapTransaction: mockTxBase64 } });
    const conn = mockConnection();

    const txId = await executeSwap(baseConfig, {}, conn);

    expect(txId).toBe('mockTxSignature123');
    expect(conn.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(conn.confirmTransaction).toHaveBeenCalledWith(
      {
        signature: 'mockTxSignature123',
        blockhash: 'GHtXQBsoZHVnNFa9YhV6xcu1GjQx3TQ91DP9avYQgxba',
        lastValidBlockHeight: 100000,
      },
      'confirmed'
    );
  });

  test('throws when Jupiter returns no swapTransaction', async () => {
    client.post.mockResolvedValue({ data: {} });
    const conn = mockConnection();

    await expect(executeSwap(baseConfig, {}, conn)).rejects.toThrow('did not return a swap transaction');
  });

  test('throws on on-chain error (confirmation.value.err set)', async () => {
    const mockTxBase64 = buildMockSwapTx();
    client.post.mockResolvedValue({ data: { swapTransaction: mockTxBase64 } });
    const conn = mockConnection({
      confirmTransaction: jest.fn().mockResolvedValue({
        value: { err: { InstructionError: [0, 'Custom'] } },
      }),
    });

    await expect(executeSwap(baseConfig, {}, conn)).rejects.toThrow('Transaction failed on-chain');
    // Should log the error with txId
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('TX Signature'));
  });

  test('includes txId and parsed error on on-chain failure', async () => {
    const mockTxBase64 = buildMockSwapTx();
    client.post.mockResolvedValue({ data: { swapTransaction: mockTxBase64 } });
    const conn = mockConnection({
      confirmTransaction: jest.fn().mockResolvedValue({
        value: { err: { InstructionError: [2, { Custom: 6001 }] } },
      }),
    });

    try {
      await executeSwap(baseConfig, {}, conn);
      fail('should have thrown');
    } catch (err) {
      expect(err.txId).toBe('mockTxSignature123');
      expect(err.onChainError).toEqual({ InstructionError: [2, { Custom: 6001 }] });
      expect(err.message).toContain('Slippage tolerance exceeded');
    }
  });

  test('fetches transaction logs on on-chain failure', async () => {
    const mockTxBase64 = buildMockSwapTx();
    client.post.mockResolvedValue({ data: { swapTransaction: mockTxBase64 } });
    const conn = mockConnection({
      confirmTransaction: jest.fn().mockResolvedValue({
        value: { err: { InstructionError: [0, { Custom: 9999 }] } },
      }),
      getTransaction: jest.fn().mockResolvedValue({
        meta: {
          logMessages: [
            'Program log: Instruction: Swap',
            'Program log: Error: insufficient output amount',
          ],
        },
      }),
    });

    await expect(executeSwap(baseConfig, {}, conn)).rejects.toThrow('Transaction failed on-chain');
    expect(conn.getTransaction).toHaveBeenCalledWith('mockTxSignature123', expect.any(Object));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Transaction logs'));
  });

  test('handles confirmation.value being null without crash (BUG-3 regression)', async () => {
    const mockTxBase64 = buildMockSwapTx();
    client.post.mockResolvedValue({ data: { swapTransaction: mockTxBase64 } });
    const conn = mockConnection({
      confirmTransaction: jest.fn().mockResolvedValue({ value: null }),
    });

    // Should NOT crash — null?.err is undefined, not TypeError
    const txId = await executeSwap(baseConfig, {}, conn);
    expect(txId).toBe('mockTxSignature123');
  });

  test('clears timer after successful confirmation (BUG-2 regression)', async () => {
    jest.useFakeTimers();
    const mockTxBase64 = buildMockSwapTx();
    client.post.mockResolvedValue({ data: { swapTransaction: mockTxBase64 } });
    const conn = mockConnection();

    const promise = executeSwap(baseConfig, {}, conn);
    jest.runAllTimers();
    const txId = await promise;

    expect(txId).toBe('mockTxSignature123');
    // If timer wasn't cleared, advancing timers would cause UnhandledPromiseRejection
    jest.advanceTimersByTime(120_000);
    jest.useRealTimers();
  });

  test('warns on invalid priority fee (BUG-4 regression)', async () => {
    const mockTxBase64 = buildMockSwapTx();
    client.post.mockResolvedValue({ data: { swapTransaction: mockTxBase64 } });
    const conn = mockConnection();
    const config = { ...baseConfig, priorityFee: 'abc' };

    await executeSwap(config, {}, conn);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Invalid PRIORITY_FEE')
    );
  });

  test('sets auto priority fee in swap body', async () => {
    const mockTxBase64 = buildMockSwapTx();
    client.post.mockResolvedValue({ data: { swapTransaction: mockTxBase64 } });
    const conn = mockConnection();

    await executeSwap(baseConfig, { someQuote: true }, conn);

    expect(client.post).toHaveBeenCalledWith(
      'https://quote-api.jup.ag/v6/swap',
      expect.objectContaining({
        prioritizationFeeLamports: 'auto',
        quoteResponse: { someQuote: true },
      }),
      expect.any(Object)
    );
  });

  test('sets numeric priority fee in swap body', async () => {
    const mockTxBase64 = buildMockSwapTx();
    client.post.mockResolvedValue({ data: { swapTransaction: mockTxBase64 } });
    const conn = mockConnection();
    const config = { ...baseConfig, priorityFee: '50000' };

    await executeSwap(config, {}, conn);

    expect(client.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ prioritizationFeeLamports: 50000 }),
      expect.any(Object)
    );
  });

  // --- retry with fee bump tests ---

  test('retries on timeout with bumped priority fee', async () => {
    const mockTxBase64 = buildMockSwapTx();
    // First attempt: timeout, second attempt: success
    client.post
      .mockResolvedValueOnce({ data: { swapTransaction: mockTxBase64 } })
      .mockResolvedValueOnce({ data: { swapTransaction: mockTxBase64 } });

    const conn = mockConnection({
      confirmTransaction: jest.fn()
        .mockRejectedValueOnce(new Error('Transaction confirmation timed out after 60s'))
        .mockResolvedValueOnce({ value: { err: null } }),
    });

    const txId = await executeSwap(baseConfig, {}, conn);

    expect(txId).toBe('mockTxSignature123');
    // Should have called post twice (initial + retry)
    expect(client.post).toHaveBeenCalledTimes(2);
    // Second call should have a numeric fee (not 'auto')
    const secondCallBody = client.post.mock.calls[1][1];
    expect(typeof secondCallBody.prioritizationFeeLamports).toBe('number');
    expect(secondCallBody.prioritizationFeeLamports).toBeGreaterThan(0);
  });

  test('retries on BlockhashNotFound with bumped fee', async () => {
    const mockTxBase64 = buildMockSwapTx();
    client.post
      .mockResolvedValueOnce({ data: { swapTransaction: mockTxBase64 } })
      .mockResolvedValueOnce({ data: { swapTransaction: mockTxBase64 } });

    const conn = mockConnection({
      sendRawTransaction: jest.fn()
        .mockRejectedValueOnce(new Error('BlockhashNotFound'))
        .mockResolvedValueOnce('txSig456'),
    });

    const txId = await executeSwap(baseConfig, {}, conn);

    expect(txId).toBe('txSig456');
    expect(client.post).toHaveBeenCalledTimes(2);
  });

  test('uses networkFeeEstimate for first retry bump', async () => {
    const mockTxBase64 = buildMockSwapTx();
    client.post
      .mockResolvedValueOnce({ data: { swapTransaction: mockTxBase64 } })
      .mockResolvedValueOnce({ data: { swapTransaction: mockTxBase64 } });

    const conn = mockConnection({
      confirmTransaction: jest.fn()
        .mockRejectedValueOnce(new Error('Transaction confirmation timed out after 60s'))
        .mockResolvedValueOnce({ value: { err: null } }),
    });

    await executeSwap(baseConfig, {}, conn, { networkFeeEstimate: 250_000 });

    // Second call should use networkFeeEstimate
    const secondCallBody = client.post.mock.calls[1][1];
    expect(secondCallBody.prioritizationFeeLamports).toBe(250_000);
  });

  test('throws after exhausting all retry attempts', async () => {
    const mockTxBase64 = buildMockSwapTx();
    // All attempts return valid tx but confirmation always times out
    client.post.mockResolvedValue({ data: { swapTransaction: mockTxBase64 } });

    const conn = mockConnection({
      confirmTransaction: jest.fn()
        .mockRejectedValue(new Error('Transaction confirmation timed out after 60s')),
    });

    await expect(executeSwap(baseConfig, {}, conn)).rejects.toThrow('timed out');
    // 3 attempts total (initial + 2 retries)
    expect(client.post).toHaveBeenCalledTimes(3);
  });

  test('does NOT retry on non-retryable errors (on-chain failure)', async () => {
    const mockTxBase64 = buildMockSwapTx();
    client.post.mockResolvedValue({ data: { swapTransaction: mockTxBase64 } });

    const conn = mockConnection({
      confirmTransaction: jest.fn().mockResolvedValue({
        value: { err: { InstructionError: [0, { Custom: 6001 }] } },
      }),
    });

    await expect(executeSwap(baseConfig, {}, conn)).rejects.toThrow('Transaction failed on-chain');
    // Only 1 attempt — no retry on on-chain errors
    expect(client.post).toHaveBeenCalledTimes(1);
  });

  test('bumps numeric priority fee by 1.5x on retry', async () => {
    const mockTxBase64 = buildMockSwapTx();
    client.post
      .mockResolvedValueOnce({ data: { swapTransaction: mockTxBase64 } })
      .mockResolvedValueOnce({ data: { swapTransaction: mockTxBase64 } })
      .mockResolvedValueOnce({ data: { swapTransaction: mockTxBase64 } });

    const conn = mockConnection({
      confirmTransaction: jest.fn()
        .mockRejectedValueOnce(new Error('Transaction confirmation timed out after 60s'))
        .mockRejectedValueOnce(new Error('Transaction confirmation timed out after 60s'))
        .mockResolvedValueOnce({ value: { err: null } }),
    });

    const config = { ...baseConfig, priorityFee: '100000' };
    await executeSwap(config, {}, conn);

    // Attempt 1: 100000, Attempt 2: 150000, Attempt 3: 225000
    expect(client.post.mock.calls[0][1].prioritizationFeeLamports).toBe(100000);
    expect(client.post.mock.calls[1][1].prioritizationFeeLamports).toBe(150000);
    expect(client.post.mock.calls[2][1].prioritizationFeeLamports).toBe(225000);
  });
});
