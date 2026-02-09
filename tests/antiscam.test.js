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

const { ethers } = require('ethers');
const { client } = require('../src/http');

const TOKEN_ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const AMOUNT_WEI = 10_000_000_000_000_000n; // 0.01 BNB

const BASE_CONFIG = {
  routerZeroxApiKey: 'test-api-key',
  zeroxApiUrl: 'https://api.0x.org',
  nativeToken: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  wallet: { address: '0xWalletAddress' },
};

// === checkProxy ===

describe('checkProxy', () => {
  const { checkProxy } = require('../src/antiscam');

  test('returns isProxy:true when implementation slot is set', async () => {
    const implAddr = '0x000000000000000000000000' + '1234567890abcdef1234567890abcdef12345678';
    const provider = {
      getStorage: jest.fn().mockResolvedValue(implAddr),
    };

    const result = await checkProxy(provider, TOKEN_ADDR);
    expect(result.isProxy).toBe(true);
    expect(result.implementation).toBeDefined();
  });

  test('returns isProxy:false when implementation slot is zero', async () => {
    const provider = {
      getStorage: jest.fn().mockResolvedValue('0x' + '0'.repeat(64)),
    };

    const result = await checkProxy(provider, TOKEN_ADDR);
    expect(result.isProxy).toBe(false);
  });

  test('returns isProxy:false on error', async () => {
    const provider = {
      getStorage: jest.fn().mockRejectedValue(new Error('RPC error')),
    };

    const result = await checkProxy(provider, TOKEN_ADDR);
    expect(result.isProxy).toBe(false);
  });
});

// === checkOwnership ===

describe('checkOwnership', () => {
  test('returns renounced:true when owner() reverts', async () => {
    jest.resetModules();
    jest.doMock('../src/logger', () => ({
      step: jest.fn(), info: jest.fn(), warn: jest.fn(),
      error: jest.fn(), success: jest.fn(), sep: jest.fn(),
    }));
    jest.doMock('../src/http', () => ({ client: { get: jest.fn() } }));
    jest.doMock('ethers', () => {
      const actual = jest.requireActual('ethers');
      return {
        ...actual,
        ethers: {
          ...actual.ethers,
          Contract: jest.fn().mockReturnValue({
            owner: jest.fn().mockRejectedValue(new Error('revert')),
          }),
        },
      };
    });

    const { checkOwnership } = require('../src/antiscam');
    const result = await checkOwnership({}, TOKEN_ADDR);
    expect(result.hasOwner).toBe(false);
    expect(result.renounced).toBe(true);
    expect(result.owner).toBeNull();

    jest.restoreAllMocks();
  });

  test('returns hasOwner:true when owner is set', async () => {
    jest.resetModules();
    jest.doMock('../src/logger', () => ({
      step: jest.fn(), info: jest.fn(), warn: jest.fn(),
      error: jest.fn(), success: jest.fn(), sep: jest.fn(),
    }));
    jest.doMock('../src/http', () => ({ client: { get: jest.fn() } }));
    jest.doMock('ethers', () => {
      const actual = jest.requireActual('ethers');
      return {
        ...actual,
        ethers: {
          ...actual.ethers,
          Contract: jest.fn().mockReturnValue({
            owner: jest.fn().mockResolvedValue('0x1234567890AbcdEF1234567890aBcdef12345678'),
          }),
          ZeroAddress: actual.ethers.ZeroAddress,
        },
      };
    });

    const { checkOwnership } = require('../src/antiscam');
    const result = await checkOwnership({}, TOKEN_ADDR);
    expect(result.hasOwner).toBe(true);
    expect(result.renounced).toBe(false);

    jest.restoreAllMocks();
  });

  test('returns renounced:true when owner is zero address', async () => {
    jest.resetModules();
    jest.doMock('../src/logger', () => ({
      step: jest.fn(), info: jest.fn(), warn: jest.fn(),
      error: jest.fn(), success: jest.fn(), sep: jest.fn(),
    }));
    jest.doMock('../src/http', () => ({ client: { get: jest.fn() } }));
    const actualEthers = jest.requireActual('ethers');
    jest.doMock('ethers', () => ({
      ...actualEthers,
      ethers: {
        ...actualEthers.ethers,
        Contract: jest.fn().mockReturnValue({
          owner: jest.fn().mockResolvedValue(actualEthers.ethers.ZeroAddress),
        }),
        ZeroAddress: actualEthers.ethers.ZeroAddress,
      },
    }));

    const { checkOwnership } = require('../src/antiscam');
    const result = await checkOwnership({}, TOKEN_ADDR);
    expect(result.hasOwner).toBe(false);
    expect(result.renounced).toBe(true);

    jest.restoreAllMocks();
  });
});

// === checkHoneypot ===

describe('checkHoneypot', () => {
  const { checkHoneypot } = require('../src/antiscam');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns canSell:true with low round-trip loss', async () => {
    // Buy: spend 0.01 BNB, get 1000000 tokens
    // Sell: sell 1000000 tokens, get 0.0095 BNB (5% loss)
    client.get
      .mockResolvedValueOnce({
        data: {
          buyAmount: '1000000',
          liquidityAvailable: true,
          tokenMetadata: { buyToken: { sellTaxBps: '0' } },
        },
      })
      .mockResolvedValueOnce({
        data: {
          buyAmount: '9500000000000000', // 0.0095 BNB
          liquidityAvailable: true,
        },
      });

    const result = await checkHoneypot(BASE_CONFIG, TOKEN_ADDR, AMOUNT_WEI);
    expect(result.canSell).toBe(true);
    expect(result.roundTripLossPct).toBe(5);
    expect(result.warning).toBeUndefined();
  });

  test('returns warning for >20% round-trip loss', async () => {
    client.get
      .mockResolvedValueOnce({
        data: {
          buyAmount: '1000000',
          liquidityAvailable: true,
          tokenMetadata: { buyToken: { sellTaxBps: '0' } },
        },
      })
      .mockResolvedValueOnce({
        data: {
          buyAmount: '7000000000000000', // 0.007 BNB = 30% loss
          liquidityAvailable: true,
        },
      });

    const result = await checkHoneypot(BASE_CONFIG, TOKEN_ADDR, AMOUNT_WEI);
    expect(result.canSell).toBe(true);
    expect(result.roundTripLossPct).toBe(30);
    expect(result.warning).toContain('High round-trip loss');
  });

  test('returns warning for >50% round-trip loss', async () => {
    client.get
      .mockResolvedValueOnce({
        data: {
          buyAmount: '1000000',
          liquidityAvailable: true,
          tokenMetadata: { buyToken: { sellTaxBps: '0' } },
        },
      })
      .mockResolvedValueOnce({
        data: {
          buyAmount: '3000000000000000', // 0.003 BNB = 70% loss
          liquidityAvailable: true,
        },
      });

    const result = await checkHoneypot(BASE_CONFIG, TOKEN_ADDR, AMOUNT_WEI);
    expect(result.canSell).toBe(true);
    expect(result.roundTripLossPct).toBe(70);
    expect(result.warning).toContain('Extreme round-trip loss');
  });

  test('returns canSell:false when sell quote fails', async () => {
    client.get
      .mockResolvedValueOnce({
        data: {
          buyAmount: '1000000',
          liquidityAvailable: true,
          tokenMetadata: { buyToken: { sellTaxBps: '0' } },
        },
      })
      .mockRejectedValueOnce(new Error('INSUFFICIENT'));

    const result = await checkHoneypot(BASE_CONFIG, TOKEN_ADDR, AMOUNT_WEI);
    expect(result.canSell).toBe(false);
    expect(result.reason).toContain('honeypot');
  });

  test('returns canSell:false when buy has no liquidity', async () => {
    client.get.mockResolvedValueOnce({
      data: {
        buyAmount: '0',
        liquidityAvailable: false,
      },
    });

    const result = await checkHoneypot(BASE_CONFIG, TOKEN_ADDR, AMOUNT_WEI);
    expect(result.canSell).toBe(false);
    expect(result.reason).toContain('No liquidity');
  });

  test('returns canSell:false when buy quote fails', async () => {
    client.get.mockRejectedValueOnce(new Error('API error'));

    const result = await checkHoneypot(BASE_CONFIG, TOKEN_ADDR, AMOUNT_WEI);
    expect(result.canSell).toBe(false);
    expect(result.reason).toContain('Buy quote failed');
  });

  test('returns canSell:false when sell has no liquidity', async () => {
    client.get
      .mockResolvedValueOnce({
        data: {
          buyAmount: '1000000',
          liquidityAvailable: true,
          tokenMetadata: { buyToken: { sellTaxBps: '0' } },
        },
      })
      .mockResolvedValueOnce({
        data: {
          buyAmount: '0',
          liquidityAvailable: false,
        },
      });

    const result = await checkHoneypot(BASE_CONFIG, TOKEN_ADDR, AMOUNT_WEI);
    expect(result.canSell).toBe(false);
    expect(result.reason).toContain('likely honeypot');
  });
});

// === runAntiScamChecks ===

describe('runAntiScamChecks', () => {
  function setupRunAntiScamChecks(httpMocks) {
    jest.resetModules();
    jest.doMock('../src/logger', () => ({
      step: jest.fn(), info: jest.fn(), warn: jest.fn(),
      error: jest.fn(), success: jest.fn(), sep: jest.fn(),
    }));
    const mockClient = { get: jest.fn() };
    httpMocks.forEach((m) => {
      if (m.reject) {
        mockClient.get.mockRejectedValueOnce(m.reject);
      } else {
        mockClient.get.mockResolvedValueOnce(m);
      }
    });
    jest.doMock('../src/http', () => ({ client: mockClient }));
    const actualEthers = jest.requireActual('ethers');
    jest.doMock('ethers', () => ({
      ...actualEthers,
      ethers: {
        ...actualEthers.ethers,
        Contract: jest.fn().mockReturnValue({
          owner: jest.fn().mockResolvedValue(actualEthers.ethers.ZeroAddress),
        }),
        ZeroAddress: actualEthers.ethers.ZeroAddress,
        getAddress: actualEthers.ethers.getAddress,
      },
    }));
    return require('../src/antiscam');
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('returns low risk for clean token', async () => {
    const { runAntiScamChecks } = setupRunAntiScamChecks([
      { data: { buyAmount: '1000000', liquidityAvailable: true, tokenMetadata: { buyToken: { sellTaxBps: '0' } } } },
      { data: { buyAmount: '9500000000000000', liquidityAvailable: true } },
    ]);

    const provider = { getStorage: jest.fn().mockResolvedValue('0x' + '0'.repeat(64)) };
    const tokenInfo = { totalSupply: 1000000n };

    const result = await runAntiScamChecks(provider, BASE_CONFIG, TOKEN_ADDR, AMOUNT_WEI, tokenInfo);
    expect(result.riskLevel).toBe('low');
    expect(result.warnings).toHaveLength(0);
  });

  test('returns critical risk for honeypot', async () => {
    const { runAntiScamChecks } = setupRunAntiScamChecks([
      { data: { buyAmount: '1000000', liquidityAvailable: true, tokenMetadata: { buyToken: { sellTaxBps: '0' } } } },
      { reject: new Error('INSUFFICIENT') },
    ]);

    const provider = { getStorage: jest.fn().mockResolvedValue('0x' + '0'.repeat(64)) };
    const tokenInfo = { totalSupply: 1000000n };

    const result = await runAntiScamChecks(provider, BASE_CONFIG, TOKEN_ADDR, AMOUNT_WEI, tokenInfo);
    expect(result.riskLevel).toBe('critical');
    expect(result.warnings.some((w) => w.includes('HONEYPOT'))).toBe(true);
  });

  test('returns high risk for upgradeable proxy', async () => {
    const { runAntiScamChecks } = setupRunAntiScamChecks([
      { data: { buyAmount: '1000000', liquidityAvailable: true, tokenMetadata: { buyToken: { sellTaxBps: '0' } } } },
      { data: { buyAmount: '9500000000000000', liquidityAvailable: true } },
    ]);

    const implAddr = '0x000000000000000000000000' + '1234567890abcdef1234567890abcdef12345678';
    const provider = { getStorage: jest.fn().mockResolvedValue(implAddr) };
    const tokenInfo = { totalSupply: 1000000n };

    const result = await runAntiScamChecks(provider, BASE_CONFIG, TOKEN_ADDR, AMOUNT_WEI, tokenInfo);
    expect(result.riskLevel).toBe('high');
    expect(result.warnings.some((w) => w.includes('upgradeable proxy'))).toBe(true);
  });

  test('warns on zero supply', async () => {
    const { runAntiScamChecks } = setupRunAntiScamChecks([
      { data: { buyAmount: '1000000', liquidityAvailable: true, tokenMetadata: { buyToken: { sellTaxBps: '0' } } } },
      { data: { buyAmount: '9500000000000000', liquidityAvailable: true } },
    ]);

    const provider = { getStorage: jest.fn().mockResolvedValue('0x' + '0'.repeat(64)) };
    const tokenInfo = { totalSupply: 0n };

    const result = await runAntiScamChecks(provider, BASE_CONFIG, TOKEN_ADDR, AMOUNT_WEI, tokenInfo);
    expect(result.warnings.some((w) => w.includes('zero supply'))).toBe(true);
  });
});
