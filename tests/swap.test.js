jest.mock('../src/logger', () => ({
  step: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  sep: jest.fn(),
}));

const { WBNB } = require('../src/config');
const { SWAP_DEADLINE_SEC } = require('../src/swap');

const TOKEN_ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const ROUTER_ADDR = '0x10ED43C718714eb63d5aA57B78B54704E256024E';

describe('getQuote', () => {
  test('returns last element from getAmountsOut', async () => {
    // Test the getQuote function with a mock router object
    const { getQuote } = require('../src/swap');
    const mockRouter = {
      getAmountsOut: jest.fn().mockResolvedValue([
        10_000_000_000_000_000n,
        5000000n,
      ]),
    };

    const result = await getQuote(mockRouter, 10_000_000_000_000_000n, [WBNB, TOKEN_ADDR]);
    expect(result).toBe(5000000n);
    expect(mockRouter.getAmountsOut).toHaveBeenCalledWith(10_000_000_000_000_000n, [WBNB, TOKEN_ADDR]);
  });

  test('handles multi-hop path', async () => {
    const { getQuote } = require('../src/swap');
    const mockRouter = {
      getAmountsOut: jest.fn().mockResolvedValue([
        10_000_000_000_000_000n,
        20000n,
        5000000n,
      ]),
    };

    const result = await getQuote(mockRouter, 10_000_000_000_000_000n, [WBNB, '0xMid', TOKEN_ADDR]);
    expect(result).toBe(5000000n);
  });
});

describe('executeBuy', () => {
  test('calls swap function with correct params', async () => {
    // We need to mock ethers.Contract at the module level
    const mockTx = {
      hash: '0xabcdef1234567890',
      wait: jest.fn().mockResolvedValue({
        status: 1,
        blockNumber: 12345,
        gasUsed: 200000n,
      }),
    };

    const mockSwapFn = jest.fn().mockResolvedValue(mockTx);
    const mockGetAmountsOut = jest.fn().mockResolvedValue([10_000_000_000_000_000n, 5000000n]);

    // Mock ethers module
    jest.doMock('ethers', () => {
      const actual = jest.requireActual('ethers');
      return {
        ...actual,
        ethers: {
          ...actual.ethers,
          Contract: jest.fn().mockReturnValue({
            getAmountsOut: mockGetAmountsOut,
            swapExactETHForTokensSupportingFeeOnTransferTokens: mockSwapFn,
          }),
        },
      };
    });

    // Re-require after mocking
    jest.resetModules();

    // Re-mock logger
    jest.doMock('../src/logger', () => ({
      step: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      success: jest.fn(),
      sep: jest.fn(),
    }));

    const { executeBuy } = require('../src/swap');

    const mockWallet = { address: '0xWallet' };
    const config = {
      buyAmountBnb: '0.01',
      buyAmountWei: 10_000_000_000_000_000n,
      slippagePercent: 5,
      gasLimit: 300000,
    };

    const result = await executeBuy(mockWallet, ROUTER_ADDR, config, TOKEN_ADDR, {});

    expect(result.hash).toBe('0xabcdef1234567890');
    expect(mockSwapFn).toHaveBeenCalledTimes(1);

    // Verify amountOutMin has slippage applied: 5000000 * 95 / 100 = 4750000
    const callArgs = mockSwapFn.mock.calls[0];
    expect(callArgs[0]).toBe(4750000n);
    // Path
    expect(callArgs[1][0]).toContain('bb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c');
    expect(callArgs[1][1]).toBe(TOKEN_ADDR);

    // Restore mocks
    jest.restoreAllMocks();
  });

  test('throws when transaction reverts', async () => {
    const mockTx = {
      hash: '0xfailed',
      wait: jest.fn().mockResolvedValue({ status: 0 }),
    };

    jest.doMock('ethers', () => {
      const actual = jest.requireActual('ethers');
      return {
        ...actual,
        ethers: {
          ...actual.ethers,
          Contract: jest.fn().mockReturnValue({
            getAmountsOut: jest.fn().mockResolvedValue([10_000_000_000_000_000n, 5000000n]),
            swapExactETHForTokensSupportingFeeOnTransferTokens: jest.fn().mockResolvedValue(mockTx),
          }),
        },
      };
    });

    jest.resetModules();
    jest.doMock('../src/logger', () => ({
      step: jest.fn(), info: jest.fn(), warn: jest.fn(),
      error: jest.fn(), success: jest.fn(), sep: jest.fn(),
    }));

    const { executeBuy } = require('../src/swap');

    const config = {
      buyAmountBnb: '0.01',
      buyAmountWei: 10_000_000_000_000_000n,
      slippagePercent: 5,
      gasLimit: 300000,
    };

    await expect(executeBuy({ address: '0xW' }, ROUTER_ADDR, config, TOKEN_ADDR, {}))
      .rejects.toThrow('reverted');

    jest.restoreAllMocks();
  });
});

describe('SWAP_DEADLINE_SEC', () => {
  test('is 300 seconds (5 minutes)', () => {
    expect(SWAP_DEADLINE_SEC).toBe(300);
  });
});
