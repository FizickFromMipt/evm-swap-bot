jest.mock('../src/logger', () => ({
  step: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  sep: jest.fn(),
}));

jest.mock('../src/http', () => ({
  client: {
    get: jest.fn(),
  },
}));

const { client } = require('../src/http');

const TOKEN_ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const WALLET_ADDR = '0xWalletAddress';

const BASE_CONFIG = {
  routerZeroxApiKey: 'test-api-key',
  zeroxApiUrl: 'https://api.0x.org',
  nativeToken: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  buyAmountBnb: '0.01',
  buyAmountWei: 10_000_000_000_000_000n,
  slippageBps: 500,
  gasLimit: 300000,
  buyRetries: 0,
  buyRetryDelayMs: 10,
};

function makeQuoteResponse(overrides = {}) {
  return {
    data: {
      buyAmount: '5000000',
      minBuyAmount: '4750000',
      liquidityAvailable: true,
      route: {
        fills: [{ source: 'PancakeSwap_V2', proportionBps: '10000' }],
      },
      tokenMetadata: {
        buyToken: { sellTaxBps: '0' },
      },
      transaction: {
        to: '0xTargetContract',
        data: '0xcalldata',
        value: '10000000000000000',
        gas: '250000',
      },
      ...overrides,
    },
  };
}

describe('getQuote', () => {
  const { getQuote } = require('../src/swap');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('calls 0x /price endpoint with correct params', async () => {
    const priceResponse = {
      data: {
        buyAmount: '5000000',
        liquidityAvailable: true,
      },
    };
    client.get.mockResolvedValue(priceResponse);

    const result = await getQuote(BASE_CONFIG, BASE_CONFIG.nativeToken, TOKEN_ADDR, 10_000_000_000_000_000n, WALLET_ADDR);

    expect(client.get).toHaveBeenCalledWith(
      'https://api.0x.org/swap/allowance-holder/price',
      expect.objectContaining({
        headers: { '0x-api-key': 'test-api-key', '0x-version': 'v2' },
        params: expect.objectContaining({
          chainId: 56,
          sellToken: BASE_CONFIG.nativeToken,
          buyToken: TOKEN_ADDR,
          sellAmount: '10000000000000000',
          taker: WALLET_ADDR,
        }),
      })
    );
    expect(result.buyAmount).toBe('5000000');
  });
});

describe('executeBuy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('sends transaction with correct params from 0x quote', async () => {
    const { executeBuy } = require('../src/swap');

    client.get.mockResolvedValue(makeQuoteResponse());

    const mockTx = {
      hash: '0xabcdef1234567890',
      wait: jest.fn().mockResolvedValue({
        status: 1,
        blockNumber: 12345,
        gasUsed: 200000n,
      }),
    };
    const mockWallet = {
      address: WALLET_ADDR,
      sendTransaction: jest.fn().mockResolvedValue(mockTx),
    };

    const result = await executeBuy(mockWallet, BASE_CONFIG, TOKEN_ADDR, {});

    expect(result.hash).toBe('0xabcdef1234567890');
    expect(result.buyAmount).toBe('5000000');
    expect(result.minBuyAmount).toBe('4750000');
    expect(result.route.fills).toHaveLength(1);

    // Verify sendTransaction called with quote data
    expect(mockWallet.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '0xTargetContract',
        data: '0xcalldata',
        value: 10_000_000_000_000_000n,
        gasLimit: 250000,
      })
    );
  });

  test('throws when transaction reverts on-chain', async () => {
    const { executeBuy } = require('../src/swap');

    client.get.mockResolvedValue(makeQuoteResponse());

    const mockTx = {
      hash: '0xfailed',
      wait: jest.fn().mockResolvedValue({ status: 0 }),
    };
    const mockWallet = {
      address: WALLET_ADDR,
      sendTransaction: jest.fn().mockResolvedValue(mockTx),
    };

    await expect(executeBuy(mockWallet, BASE_CONFIG, TOKEN_ADDR, {}))
      .rejects.toThrow('reverted');
  });

  test('throws when no liquidity available', async () => {
    const { executeBuy } = require('../src/swap');

    client.get.mockResolvedValue(makeQuoteResponse({ liquidityAvailable: false }));

    const mockWallet = {
      address: WALLET_ADDR,
      sendTransaction: jest.fn(),
    };

    await expect(executeBuy(mockWallet, BASE_CONFIG, TOKEN_ADDR, {}))
      .rejects.toThrow('No liquidity');
    expect(mockWallet.sendTransaction).not.toHaveBeenCalled();
  });

  test('uses config gasLimit as fallback when quote has no gas', async () => {
    const { executeBuy } = require('../src/swap');

    const noGasQuote = makeQuoteResponse();
    delete noGasQuote.data.transaction.gas;
    client.get.mockResolvedValue(noGasQuote);

    const mockTx = {
      hash: '0xhash',
      wait: jest.fn().mockResolvedValue({ status: 1, blockNumber: 1, gasUsed: 100000n }),
    };
    const mockWallet = {
      address: WALLET_ADDR,
      sendTransaction: jest.fn().mockResolvedValue(mockTx),
    };

    await executeBuy(mockWallet, BASE_CONFIG, TOKEN_ADDR, {});

    expect(mockWallet.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ gasLimit: 300000 })
    );
  });

  test('applies gasPrice from gasSettings', async () => {
    const { executeBuy } = require('../src/swap');

    client.get.mockResolvedValue(makeQuoteResponse());

    const mockTx = {
      hash: '0xhash',
      wait: jest.fn().mockResolvedValue({ status: 1, blockNumber: 1, gasUsed: 100000n }),
    };
    const mockWallet = {
      address: WALLET_ADDR,
      sendTransaction: jest.fn().mockResolvedValue(mockTx),
    };

    await executeBuy(mockWallet, BASE_CONFIG, TOKEN_ADDR, { gasPrice: 5_000_000_000n });

    expect(mockWallet.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ gasPrice: 5_000_000_000n })
    );
  });

  test('logs sell tax warning when present', async () => {
    const { executeBuy } = require('../src/swap');
    const logger = require('../src/logger');

    client.get.mockResolvedValue(makeQuoteResponse({
      tokenMetadata: { buyToken: { sellTaxBps: '500' } },
    }));

    const mockTx = {
      hash: '0xhash',
      wait: jest.fn().mockResolvedValue({ status: 1, blockNumber: 1, gasUsed: 100000n }),
    };
    const mockWallet = {
      address: WALLET_ADDR,
      sendTransaction: jest.fn().mockResolvedValue(mockTx),
    };

    await executeBuy(mockWallet, BASE_CONFIG, TOKEN_ADDR, {});

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('sell tax'));
  });
});

describe('formatRoute', () => {
  const { formatRoute } = require('../src/swap');

  test('formats single fill', () => {
    const route = { fills: [{ source: 'PancakeSwap_V2', proportionBps: '10000' }] };
    expect(formatRoute(route)).toBe('PancakeSwap_V2 (100%)');
  });

  test('formats multi-fill', () => {
    const route = {
      fills: [
        { source: 'PancakeSwap_V2', proportionBps: '6000' },
        { source: 'DODO', proportionBps: '4000' },
      ],
    };
    expect(formatRoute(route)).toBe('PancakeSwap_V2 (60%) + DODO (40%)');
  });

  test('returns unknown for empty route', () => {
    expect(formatRoute(null)).toBe('unknown');
    expect(formatRoute({})).toBe('unknown');
    expect(formatRoute({ fills: [] })).toBe('unknown');
  });
});

describe('ZEROX_HEADERS', () => {
  const { ZEROX_HEADERS } = require('../src/swap');

  test('returns correct headers', () => {
    const headers = ZEROX_HEADERS('my-key');
    expect(headers['0x-api-key']).toBe('my-key');
    expect(headers['0x-version']).toBe('v2');
  });
});
