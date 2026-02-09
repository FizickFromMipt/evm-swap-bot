jest.mock('../src/logger', () => ({
  step: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  sep: jest.fn(),
}));

describe('getTokenInfo', () => {
  test('returns token info with all fields', async () => {
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
            name: jest.fn().mockResolvedValue('TestToken'),
            symbol: jest.fn().mockResolvedValue('TST'),
            decimals: jest.fn().mockResolvedValue(18),
            totalSupply: jest.fn().mockResolvedValue(1000000n * 10n ** 18n),
            owner: jest.fn().mockResolvedValue('0x1234567890AbcdEF1234567890aBcdef12345678'),
          }),
        },
      };
    });

    const { getTokenInfo } = require('../src/onchain');
    const result = await getTokenInfo({}, '0xABCD');
    expect(result.name).toBe('TestToken');
    expect(result.symbol).toBe('TST');
    expect(result.decimals).toBe(18);
    expect(result.totalSupply).toBe(1000000n * 10n ** 18n);
    expect(result.owner).toBe('0x1234567890AbcdEF1234567890aBcdef12345678');

    jest.restoreAllMocks();
  });

  test('handles missing owner() gracefully', async () => {
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
            name: jest.fn().mockResolvedValue('NoOwner'),
            symbol: jest.fn().mockResolvedValue('NO'),
            decimals: jest.fn().mockResolvedValue(9),
            totalSupply: jest.fn().mockResolvedValue(100n),
            owner: jest.fn().mockRejectedValue(new Error('not a function')),
          }),
        },
      };
    });

    const { getTokenInfo } = require('../src/onchain');
    const result = await getTokenInfo({}, '0xABCD');
    expect(result.owner).toBeNull();
    expect(result.name).toBe('NoOwner');

    jest.restoreAllMocks();
  });

  test('handles failing name/symbol gracefully', async () => {
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
            name: jest.fn().mockRejectedValue(new Error('revert')),
            symbol: jest.fn().mockRejectedValue(new Error('revert')),
            decimals: jest.fn().mockResolvedValue(18),
            totalSupply: jest.fn().mockResolvedValue(0n),
            owner: jest.fn().mockRejectedValue(new Error('no')),
          }),
        },
      };
    });

    const { getTokenInfo } = require('../src/onchain');
    const result = await getTokenInfo({}, '0xABCD');
    expect(result.name).toBe('Unknown');
    expect(result.symbol).toBe('???');

    jest.restoreAllMocks();
  });
});
