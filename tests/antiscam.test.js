jest.mock('../src/logger', () => ({
  step: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  sep: jest.fn(),
}));

const { ethers } = require('ethers');

const TOKEN_ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const ROUTER_ADDR = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const AMOUNT_WEI = 10_000_000_000_000_000n; // 0.01 BNB

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
  test('returns canSell:true with low round-trip loss', async () => {
    jest.resetModules();
    jest.doMock('../src/logger', () => ({
      step: jest.fn(), info: jest.fn(), warn: jest.fn(),
      error: jest.fn(), success: jest.fn(), sep: jest.fn(),
    }));
    jest.doMock('ethers', () => {
      const actual = jest.requireActual('ethers');
      return {
        ...actual,
        ethers: {
          ...actual.ethers,
          Contract: jest.fn().mockReturnValue({
            getAmountsOut: jest.fn()
              .mockResolvedValueOnce([AMOUNT_WEI, 1000000n]) // buy
              .mockResolvedValueOnce([1000000n, 9500000000000000n]), // sell (95% return)
          }),
        },
      };
    });

    const { checkHoneypot } = require('../src/antiscam');
    const result = await checkHoneypot({}, ROUTER_ADDR, TOKEN_ADDR, AMOUNT_WEI);
    expect(result.canSell).toBe(true);
    expect(result.roundTripLossPct).toBe(5);
    expect(result.warning).toBeUndefined();

    jest.restoreAllMocks();
  });

  test('returns warning for >20% round-trip loss', async () => {
    jest.resetModules();
    jest.doMock('../src/logger', () => ({
      step: jest.fn(), info: jest.fn(), warn: jest.fn(),
      error: jest.fn(), success: jest.fn(), sep: jest.fn(),
    }));
    jest.doMock('ethers', () => {
      const actual = jest.requireActual('ethers');
      return {
        ...actual,
        ethers: {
          ...actual.ethers,
          Contract: jest.fn().mockReturnValue({
            getAmountsOut: jest.fn()
              .mockResolvedValueOnce([AMOUNT_WEI, 1000000n])
              .mockResolvedValueOnce([1000000n, 7000000000000000n]), // 70% return = 30% loss
          }),
        },
      };
    });

    const { checkHoneypot } = require('../src/antiscam');
    const result = await checkHoneypot({}, ROUTER_ADDR, TOKEN_ADDR, AMOUNT_WEI);
    expect(result.canSell).toBe(true);
    expect(result.roundTripLossPct).toBe(30);
    expect(result.warning).toContain('High round-trip loss');

    jest.restoreAllMocks();
  });

  test('returns canSell:false when sell quote fails', async () => {
    jest.resetModules();
    jest.doMock('../src/logger', () => ({
      step: jest.fn(), info: jest.fn(), warn: jest.fn(),
      error: jest.fn(), success: jest.fn(), sep: jest.fn(),
    }));
    jest.doMock('ethers', () => {
      const actual = jest.requireActual('ethers');
      return {
        ...actual,
        ethers: {
          ...actual.ethers,
          Contract: jest.fn().mockReturnValue({
            getAmountsOut: jest.fn()
              .mockResolvedValueOnce([AMOUNT_WEI, 1000000n])
              .mockRejectedValueOnce(new Error('INSUFFICIENT')),
          }),
        },
      };
    });

    const { checkHoneypot } = require('../src/antiscam');
    const result = await checkHoneypot({}, ROUTER_ADDR, TOKEN_ADDR, AMOUNT_WEI);
    expect(result.canSell).toBe(false);
    expect(result.reason).toContain('honeypot');

    jest.restoreAllMocks();
  });
});

// === runAntiScamChecks ===

describe('runAntiScamChecks', () => {
  test('returns low risk for clean token', async () => {
    jest.resetModules();
    jest.doMock('../src/logger', () => ({
      step: jest.fn(), info: jest.fn(), warn: jest.fn(),
      error: jest.fn(), success: jest.fn(), sep: jest.fn(),
    }));
    const actualEthers = jest.requireActual('ethers');
    jest.doMock('ethers', () => ({
      ...actualEthers,
      ethers: {
        ...actualEthers.ethers,
        Contract: jest.fn().mockImplementation((addr, abi) => {
          if (Array.isArray(abi) && abi.some(a => typeof a === 'string' && a.includes('getAmountsOut'))) {
            return {
              getAmountsOut: jest.fn()
                .mockResolvedValueOnce([AMOUNT_WEI, 1000000n])
                .mockResolvedValueOnce([1000000n, 9500000000000000n]),
            };
          }
          return { owner: jest.fn().mockResolvedValue(actualEthers.ethers.ZeroAddress) };
        }),
        ZeroAddress: actualEthers.ethers.ZeroAddress,
        getAddress: actualEthers.ethers.getAddress,
      },
    }));

    const { runAntiScamChecks } = require('../src/antiscam');
    const provider = { getStorage: jest.fn().mockResolvedValue('0x' + '0'.repeat(64)) };
    const tokenInfo = { totalSupply: 1000000n };

    const result = await runAntiScamChecks(provider, ROUTER_ADDR, TOKEN_ADDR, AMOUNT_WEI, tokenInfo);
    expect(result.riskLevel).toBe('low');
    expect(result.warnings).toHaveLength(0);

    jest.restoreAllMocks();
  });

  test('returns critical risk for honeypot', async () => {
    jest.resetModules();
    jest.doMock('../src/logger', () => ({
      step: jest.fn(), info: jest.fn(), warn: jest.fn(),
      error: jest.fn(), success: jest.fn(), sep: jest.fn(),
    }));
    const actualEthers = jest.requireActual('ethers');
    jest.doMock('ethers', () => ({
      ...actualEthers,
      ethers: {
        ...actualEthers.ethers,
        Contract: jest.fn().mockImplementation((addr, abi) => {
          if (Array.isArray(abi) && abi.some(a => typeof a === 'string' && a.includes('getAmountsOut'))) {
            return {
              getAmountsOut: jest.fn()
                .mockResolvedValueOnce([AMOUNT_WEI, 1000000n])
                .mockRejectedValueOnce(new Error('INSUFFICIENT')),
            };
          }
          return { owner: jest.fn().mockResolvedValue(actualEthers.ethers.ZeroAddress) };
        }),
        ZeroAddress: actualEthers.ethers.ZeroAddress,
        getAddress: actualEthers.ethers.getAddress,
      },
    }));

    const { runAntiScamChecks } = require('../src/antiscam');
    const provider = { getStorage: jest.fn().mockResolvedValue('0x' + '0'.repeat(64)) };
    const tokenInfo = { totalSupply: 1000000n };

    const result = await runAntiScamChecks(provider, ROUTER_ADDR, TOKEN_ADDR, AMOUNT_WEI, tokenInfo);
    expect(result.riskLevel).toBe('critical');
    expect(result.warnings.some((w) => w.includes('HONEYPOT'))).toBe(true);

    jest.restoreAllMocks();
  });

  test('returns high risk for upgradeable proxy', async () => {
    jest.resetModules();
    jest.doMock('../src/logger', () => ({
      step: jest.fn(), info: jest.fn(), warn: jest.fn(),
      error: jest.fn(), success: jest.fn(), sep: jest.fn(),
    }));
    const actualEthers = jest.requireActual('ethers');
    jest.doMock('ethers', () => ({
      ...actualEthers,
      ethers: {
        ...actualEthers.ethers,
        Contract: jest.fn().mockImplementation((addr, abi) => {
          if (Array.isArray(abi) && abi.some(a => typeof a === 'string' && a.includes('getAmountsOut'))) {
            return {
              getAmountsOut: jest.fn()
                .mockResolvedValueOnce([AMOUNT_WEI, 1000000n])
                .mockResolvedValueOnce([1000000n, 9500000000000000n]),
            };
          }
          return { owner: jest.fn().mockResolvedValue(actualEthers.ethers.ZeroAddress) };
        }),
        ZeroAddress: actualEthers.ethers.ZeroAddress,
        getAddress: actualEthers.ethers.getAddress,
      },
    }));

    const { runAntiScamChecks } = require('../src/antiscam');
    const implAddr = '0x000000000000000000000000' + '1234567890abcdef1234567890abcdef12345678';
    const provider = { getStorage: jest.fn().mockResolvedValue(implAddr) };
    const tokenInfo = { totalSupply: 1000000n };

    const result = await runAntiScamChecks(provider, ROUTER_ADDR, TOKEN_ADDR, AMOUNT_WEI, tokenInfo);
    expect(result.riskLevel).toBe('high');
    expect(result.warnings.some((w) => w.includes('upgradeable proxy'))).toBe(true);

    jest.restoreAllMocks();
  });

  test('returns medium risk for non-renounced ownership', async () => {
    jest.resetModules();
    jest.doMock('../src/logger', () => ({
      step: jest.fn(), info: jest.fn(), warn: jest.fn(),
      error: jest.fn(), success: jest.fn(), sep: jest.fn(),
    }));
    const actualEthers = jest.requireActual('ethers');
    jest.doMock('ethers', () => ({
      ...actualEthers,
      ethers: {
        ...actualEthers.ethers,
        Contract: jest.fn().mockImplementation((addr, abi) => {
          if (Array.isArray(abi) && abi.some(a => typeof a === 'string' && a.includes('getAmountsOut'))) {
            return {
              getAmountsOut: jest.fn()
                .mockResolvedValueOnce([AMOUNT_WEI, 1000000n])
                .mockResolvedValueOnce([1000000n, 9500000000000000n]),
            };
          }
          return { owner: jest.fn().mockResolvedValue('0x1234567890AbcdEF1234567890aBcdef12345678') };
        }),
        ZeroAddress: actualEthers.ethers.ZeroAddress,
        getAddress: actualEthers.ethers.getAddress,
      },
    }));

    const { runAntiScamChecks } = require('../src/antiscam');
    const provider = { getStorage: jest.fn().mockResolvedValue('0x' + '0'.repeat(64)) };
    const tokenInfo = { totalSupply: 1000000n };

    const result = await runAntiScamChecks(provider, ROUTER_ADDR, TOKEN_ADDR, AMOUNT_WEI, tokenInfo);
    expect(result.riskLevel).toBe('medium');
    expect(result.warnings.some((w) => w.includes('Ownership NOT renounced'))).toBe(true);

    jest.restoreAllMocks();
  });

  test('warns on zero supply', async () => {
    jest.resetModules();
    jest.doMock('../src/logger', () => ({
      step: jest.fn(), info: jest.fn(), warn: jest.fn(),
      error: jest.fn(), success: jest.fn(), sep: jest.fn(),
    }));
    const actualEthers = jest.requireActual('ethers');
    jest.doMock('ethers', () => ({
      ...actualEthers,
      ethers: {
        ...actualEthers.ethers,
        Contract: jest.fn().mockImplementation((addr, abi) => {
          if (Array.isArray(abi) && abi.some(a => typeof a === 'string' && a.includes('getAmountsOut'))) {
            return {
              getAmountsOut: jest.fn()
                .mockResolvedValueOnce([AMOUNT_WEI, 1000000n])
                .mockResolvedValueOnce([1000000n, 9500000000000000n]),
            };
          }
          return { owner: jest.fn().mockResolvedValue(actualEthers.ethers.ZeroAddress) };
        }),
        ZeroAddress: actualEthers.ethers.ZeroAddress,
        getAddress: actualEthers.ethers.getAddress,
      },
    }));

    const { runAntiScamChecks } = require('../src/antiscam');
    const provider = { getStorage: jest.fn().mockResolvedValue('0x' + '0'.repeat(64)) };
    const tokenInfo = { totalSupply: 0n };

    const result = await runAntiScamChecks(provider, ROUTER_ADDR, TOKEN_ADDR, AMOUNT_WEI, tokenInfo);
    expect(result.warnings.some((w) => w.includes('zero supply'))).toBe(true);

    jest.restoreAllMocks();
  });
});
