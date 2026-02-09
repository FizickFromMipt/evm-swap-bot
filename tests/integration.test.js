/**
 * Integration tests — verify the full production flow with mocked I/O boundaries.
 *
 * These tests import main() from index.js, mock all external dependencies
 * (RPC, HTTP APIs, filesystem), and verify the orchestration logic end-to-end.
 */

// --- Shared mock fns (survive jest.resetModules) ---

const mockClientGet = jest.fn();
const mockClientPost = jest.fn();
const mockLogBanner = jest.fn();
const mockLogStep = jest.fn();
const mockLogInfo = jest.fn();
const mockLogWarn = jest.fn();
const mockLogError = jest.fn();
const mockLogSuccess = jest.fn();
const mockLogSep = jest.fn();
const mockLogPool = jest.fn();
const mockLogRoute = jest.fn();

jest.mock('../src/logger', () => ({
  banner: mockLogBanner,
  step: mockLogStep,
  info: mockLogInfo,
  warn: mockLogWarn,
  error: mockLogError,
  success: mockLogSuccess,
  sep: mockLogSep,
  pool: mockLogPool,
  route: mockLogRoute,
}));

jest.mock('../src/http', () => ({
  client: { get: mockClientGet, post: mockClientPost },
  httpsAgent: {},
  httpAgent: {},
}));

// Bypass retry delays in integration tests
jest.mock('../src/retry', () => ({
  withRetry: jest.fn((fn) => fn()),
}));

const { Keypair, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');

// Stable test keypair
const testKeypair = Keypair.generate();
const testKeyBase58 = bs58.encode(testKeypair.secretKey);

// Mock Connection (shared across resets)
const mockConn = {
  getVersion: jest.fn(),
  getSlot: jest.fn(),
  getLatestBlockhash: jest.fn(),
  getBalance: jest.fn(),
  getGenesisHash: jest.fn(),
  getRecentPrioritizationFees: jest.fn(),
  getAccountInfo: jest.fn(),
  sendRawTransaction: jest.fn(),
  confirmTransaction: jest.fn(),
  getTransaction: jest.fn(),
};

jest.mock('@solana/web3.js', () => {
  const actual = jest.requireActual('@solana/web3.js');
  return {
    ...actual,
    Connection: jest.fn().mockImplementation(() => mockConn),
  };
});

// --- Helpers ---

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const VALID_TOKEN_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function buildMintBuffer({ supply = 1_000_000_000n, decimals = 6, isInitialized = true } = {}) {
  const buf = Buffer.alloc(82, 0);
  buf.writeBigUInt64LE(supply, 36);
  buf[44] = decimals;
  buf[45] = isInitialized ? 1 : 0;
  return buf;
}

function buildMockSwapTx() {
  const { VersionedTransaction, MessageV0 } = jest.requireActual('@solana/web3.js');
  const msg = MessageV0.compile({
    payerKey: testKeypair.publicKey,
    instructions: [],
    recentBlockhash: 'GHtXQBsoZHVnNFa9YhV6xcu1GjQx3TQ91DP9avYQgxba',
  });
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
}

const mockQuote = {
  outAmount: '1000000',
  otherAmountThreshold: '950000',
  priceImpactPct: '0.5',
  swapMode: 'ExactIn',
  routePlan: [{
    swapInfo: {
      label: 'Raydium', ammKey: 'AMMkey123',
      inAmount: '10000000', outAmount: '1000000',
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: VALID_TOKEN_MINT,
    },
    percent: 100,
  }],
};

const mockPool = {
  chainId: 'solana', dexId: 'raydium', pairAddress: 'PoolAddr123',
  baseToken: { address: VALID_TOKEN_MINT, symbol: 'USDC' },
  quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
  liquidity: { usd: 500000 }, volume: { h24: 100000 },
  txns: { h24: { buys: 200, sells: 180 } }, priceUsd: '1.00', labels: ['v4'],
};

// --- Setup defaults ---

function setupDefaults() {
  mockConn.getVersion.mockResolvedValue({ 'solana-core': '1.18.0' });
  mockConn.getSlot.mockResolvedValue(250000000);
  mockConn.getLatestBlockhash.mockResolvedValue({
    blockhash: 'GHtXQBsoZHVnNFa9YhV6xcu1GjQx3TQ91DP9avYQgxba',
    lastValidBlockHeight: 250000100,
  });
  mockConn.getBalance.mockResolvedValue(500_000_000); // 0.5 SOL
  mockConn.getGenesisHash.mockResolvedValue('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'); // devnet
  mockConn.getRecentPrioritizationFees.mockResolvedValue([
    { slot: 1, prioritizationFee: 1000 },
    { slot: 2, prioritizationFee: 2000 },
  ]);
  mockConn.getAccountInfo.mockResolvedValue({
    owner: new PublicKey(TOKEN_PROGRAM_ID),
    data: buildMintBuffer(),
    lamports: 1_000_000,
  });
  mockConn.sendRawTransaction.mockResolvedValue('mockTxSig123abc');
  mockConn.confirmTransaction.mockResolvedValue({ value: { err: null } });
  mockConn.getTransaction.mockResolvedValue(null);

  // Jupiter quote (GET) — return quote for any URL
  mockClientGet.mockResolvedValue({ data: { ...mockQuote } });

  // Jupiter swap (POST) — return signed tx
  mockClientPost.mockResolvedValue({ data: { swapTransaction: buildMockSwapTx() } });
}

const originalArgv = process.argv;
const originalEnv = { ...process.env };
let mockExit;

beforeEach(() => {
  jest.clearAllMocks();

  process.env = { ...originalEnv };
  process.env.SOLANA_RPC_URL = 'https://api.devnet.solana.com';
  process.env.PRIVATE_KEY = testKeyBase58;
  process.env.BUY_AMOUNT_SOL = '0.01';
  process.env.SLIPPAGE_BPS = '500';

  mockExit = jest.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`EXIT_${code}`);
  });

  setupDefaults();
});

afterEach(() => {
  process.argv = originalArgv;
  mockExit.mockRestore();
});

afterAll(() => {
  process.env = originalEnv;
});

// --- Integration tests ---

describe('Integration: full flow', () => {
  test('dry-run completes the full analysis pipeline and exits 0', async () => {
    jest.resetModules();
    process.argv = ['node', 'index.js', VALID_TOKEN_MINT, '--dry-run', '--yes'];

    const { main } = require('../src/index');
    await expect(main()).rejects.toThrow('EXIT_0');
    expect(mockExit).toHaveBeenCalledWith(0);

    // Verify all major steps executed
    expect(mockLogBanner).toHaveBeenCalled();
    expect(mockConn.getVersion).toHaveBeenCalled();                   // warmup
    expect(mockConn.getGenesisHash).toHaveBeenCalled();               // network detection
    expect(mockConn.getRecentPrioritizationFees).toHaveBeenCalled();  // fee estimation
    expect(mockConn.getAccountInfo).toHaveBeenCalled();               // token validation
    expect(mockClientGet).toHaveBeenCalled();                         // Jupiter quote
    expect(mockLogSuccess).toHaveBeenCalledWith(expect.stringContaining('Dry run complete'));

    // Swap NOT executed
    expect(mockConn.sendRawTransaction).not.toHaveBeenCalled();
  });

  test('successful swap with --yes executes the full flow', async () => {
    jest.resetModules();
    process.argv = ['node', 'index.js', VALID_TOKEN_MINT, '--yes'];

    const { main } = require('../src/index');
    await main(); // Should complete without process.exit

    expect(mockConn.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(mockConn.confirmTransaction).toHaveBeenCalledTimes(1);
    expect(mockLogSuccess).toHaveBeenCalledWith(expect.stringContaining('Swap completed'));
    expect(mockLogInfo).toHaveBeenCalledWith(expect.stringContaining('mockTxSig123abc'));
    expect(mockLogInfo).toHaveBeenCalledWith(expect.stringContaining('solscan.io'));
  });

  test('insufficient balance exits with code 4', async () => {
    jest.resetModules();
    mockConn.getBalance.mockResolvedValue(1_000); // 0.000001 SOL
    process.argv = ['node', 'index.js', VALID_TOKEN_MINT, '--yes'];

    const { main } = require('../src/index');
    await expect(main()).rejects.toThrow('EXIT_4');
    expect(mockExit).toHaveBeenCalledWith(4);
    expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining('Insufficient SOL'));
  });

  test('invalid token mint on-chain exits with code 8', async () => {
    jest.resetModules();
    mockConn.getAccountInfo.mockResolvedValue(null); // Not found
    process.argv = ['node', 'index.js', VALID_TOKEN_MINT, '--yes'];

    const { main } = require('../src/index');
    await expect(main()).rejects.toThrow('EXIT_8');
    expect(mockExit).toHaveBeenCalledWith(8);
    expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining('Token mint validation failed'));
  });

  test('honeypot detection triggers SCAM_DETECTED exit (code 10)', async () => {
    jest.resetModules();
    // Route by URL: DexScreener calls are ignored (will fail gracefully),
    // Jupiter buy quote returns valid data, honeypot sell quote returns empty
    let jupiterQuoteCount = 0;
    mockClientGet.mockImplementation((url) => {
      if (typeof url === 'string' && url.includes('jup.ag')) {
        jupiterQuoteCount++;
        if (jupiterQuoteCount <= 1) {
          // Buy quote — valid
          return Promise.resolve({ data: { ...mockQuote } });
        }
        // Sell quote (honeypot sim) — no route
        return Promise.resolve({ data: {} });
      }
      // DexScreener or other — return something that'll be caught gracefully
      return Promise.resolve({ data: { pairs: [] } });
    });

    process.argv = ['node', 'index.js', VALID_TOKEN_MINT, '--dry-run'];

    const { main } = require('../src/index');
    await expect(main()).rejects.toThrow('EXIT_10');
    expect(mockExit).toHaveBeenCalledWith(10);
    expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining('CRITICAL risk'));
  });

  test('DexScreener failure does not block the flow', async () => {
    jest.resetModules();

    // DexScreener is called via fetchPools which uses client.get with the dexscreener URL.
    // But since withRetry is mocked to just call fn(), we need the actual dexscreener call
    // to fail. The issue is fetchPools wraps client.get and checks the response.
    // Let's make it so that when the dexscreener module's fetchPools is called, it throws.
    // Since all client.get calls go through the same mock, let's track by URL.
    // Actually, the mock setup returns mockQuote for all GET calls. But fetchPools expects
    // { data: { pairs: [...] } }. So it will naturally fail with the wrong response shape.
    // Let's verify the flow continues past the failure.

    process.argv = ['node', 'index.js', VALID_TOKEN_MINT, '--dry-run', '--yes'];

    const { main } = require('../src/index');
    await expect(main()).rejects.toThrow('EXIT_0');
    expect(mockLogSuccess).toHaveBeenCalledWith(expect.stringContaining('Dry run complete'));
  });

  test('swap on-chain failure logs full context and exits with code 6', async () => {
    jest.resetModules();
    mockConn.confirmTransaction.mockResolvedValue({
      value: { err: { InstructionError: [2, { Custom: 6001 }] } },
    });

    process.argv = ['node', 'index.js', VALID_TOKEN_MINT, '--yes'];

    const { main } = require('../src/index');
    await expect(main()).rejects.toThrow('EXIT_6');
    expect(mockExit).toHaveBeenCalledWith(6);

    // Full context logged on failure
    expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining('Swap failed'));
    expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining('Token:'));
    expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining('Amount:'));
    expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining('Slippage:'));
  });

  test('network detection identifies devnet', async () => {
    jest.resetModules();
    process.argv = ['node', 'index.js', VALID_TOKEN_MINT, '--dry-run', '--yes'];

    const { main } = require('../src/index');
    await expect(main()).rejects.toThrow('EXIT_0');
    expect(mockLogInfo).toHaveBeenCalledWith(expect.stringContaining('devnet'));
  });

  test('--amount CLI override changes buy amount', async () => {
    jest.resetModules();
    process.argv = ['node', 'index.js', VALID_TOKEN_MINT, '--amount', '0.1', '--dry-run', '--yes'];

    const { main } = require('../src/index');
    await expect(main()).rejects.toThrow('EXIT_0');
    expect(mockLogInfo).toHaveBeenCalledWith(expect.stringContaining('--amount 0.1 SOL'));
  });

  test('RPC warmup failure exits with code 3', async () => {
    jest.resetModules();
    mockConn.getVersion.mockRejectedValue(new Error('Connection refused'));
    process.argv = ['node', 'index.js', VALID_TOKEN_MINT, '--yes'];

    const { main } = require('../src/index');
    await expect(main()).rejects.toThrow('EXIT_3');
    expect(mockExit).toHaveBeenCalledWith(3);
    expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining('RPC warmup failed'));
  });

  test('flow executes steps in correct order', async () => {
    jest.resetModules();
    const callOrder = [];

    mockConn.getVersion.mockImplementation(() => {
      callOrder.push('warmup');
      return Promise.resolve({ 'solana-core': '1.18.0' });
    });
    mockConn.getGenesisHash.mockImplementation(() => {
      callOrder.push('network');
      return Promise.resolve('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
    });
    mockConn.getRecentPrioritizationFees.mockImplementation(() => {
      callOrder.push('fees');
      return Promise.resolve([{ slot: 1, prioritizationFee: 1000 }]);
    });
    mockConn.getAccountInfo.mockImplementation(() => {
      callOrder.push('onchain');
      return Promise.resolve({
        owner: new PublicKey(TOKEN_PROGRAM_ID),
        data: buildMintBuffer(),
        lamports: 1_000_000,
      });
    });
    mockClientGet.mockImplementation(() => {
      callOrder.push('http_get');
      return Promise.resolve({ data: { ...mockQuote } });
    });

    process.argv = ['node', 'index.js', VALID_TOKEN_MINT, '--dry-run', '--yes'];

    const { main } = require('../src/index');
    await expect(main()).rejects.toThrow('EXIT_0');

    // Warmup must come first
    expect(callOrder[0]).toBe('warmup');

    // Network detection after warmup
    const netIdx = callOrder.indexOf('network');
    expect(netIdx).toBeGreaterThan(0);

    // Fee estimation after network
    const feeIdx = callOrder.indexOf('fees');
    expect(feeIdx).toBeGreaterThan(netIdx);

    // On-chain validation after fees
    const onchainIdx = callOrder.indexOf('onchain');
    expect(onchainIdx).toBeGreaterThan(feeIdx);

    // HTTP calls (quote) after on-chain
    const httpIdx = callOrder.lastIndexOf('http_get');
    expect(httpIdx).toBeGreaterThan(onchainIdx);
  });
});
