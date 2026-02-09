jest.mock('../src/logger', () => ({
  step: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  success: jest.fn(),
  sep: jest.fn(),
}));

const { ethers } = require('ethers');
const { getGasPrice } = require('../src/fees');

describe('getGasPrice', () => {
  test('returns gas price when within cap', async () => {
    const provider = {
      getFeeData: jest.fn().mockResolvedValue({
        gasPrice: ethers.parseUnits('3', 'gwei'),
      }),
    };

    const result = await getGasPrice(provider, 5);
    expect(result.gasPrice).toBe(ethers.parseUnits('3', 'gwei'));
    expect(result.gasPriceGwei).toBeCloseTo(3, 1);
    expect(result.capped).toBe(false);
  });

  test('caps gas price when exceeding max', async () => {
    const provider = {
      getFeeData: jest.fn().mockResolvedValue({
        gasPrice: ethers.parseUnits('10', 'gwei'),
      }),
    };

    const result = await getGasPrice(provider, 5);
    expect(result.gasPrice).toBe(ethers.parseUnits('5', 'gwei'));
    expect(result.gasPriceGwei).toBe(5);
    expect(result.capped).toBe(true);
  });

  test('throws when provider returns no gas price', async () => {
    const provider = {
      getFeeData: jest.fn().mockResolvedValue({ gasPrice: null }),
    };

    await expect(getGasPrice(provider, 5)).rejects.toThrow('no gas price data');
  });

  test('handles exact cap value (not capped)', async () => {
    const provider = {
      getFeeData: jest.fn().mockResolvedValue({
        gasPrice: ethers.parseUnits('5', 'gwei'),
      }),
    };

    const result = await getGasPrice(provider, 5);
    expect(result.capped).toBe(false);
  });
});
