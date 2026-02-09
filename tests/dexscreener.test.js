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
}));

const { client } = require('../src/http');
const { fetchPools } = require('../src/dexscreener');

describe('fetchPools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns only BSC pairs', async () => {
    client.get.mockResolvedValue({
      data: {
        pairs: [
          { chainId: 'bsc', dexId: 'pancakeswap', pairAddress: 'p1' },
          { chainId: 'ethereum', dexId: 'uniswap', pairAddress: 'p2' },
          { chainId: 'bsc', dexId: 'biswap', pairAddress: 'p3' },
          { chainId: 'solana', dexId: 'raydium', pairAddress: 'p4' },
        ],
      },
    });

    const pools = await fetchPools('https://api.dexscreener.com/latest/dex/tokens', '0xABCD');
    expect(pools).toHaveLength(2);
    expect(pools.every((p) => p.chainId === 'bsc')).toBe(true);
  });

  test('throws when API returns no pairs field', async () => {
    client.get.mockResolvedValue({ data: {} });
    await expect(fetchPools('url', '0xABCD')).rejects.toThrow('no pairs');
  });

  test('throws when API returns null data', async () => {
    client.get.mockResolvedValue({ data: null });
    await expect(fetchPools('url', '0xABCD')).rejects.toThrow('no pairs');
  });

  test('throws when no BSC pairs exist', async () => {
    client.get.mockResolvedValue({
      data: { pairs: [{ chainId: 'ethereum' }, { chainId: 'solana' }] },
    });
    await expect(fetchPools('url', '0xABCD')).rejects.toThrow('No BSC pools');
  });

  test('error message lists available chains', async () => {
    client.get.mockResolvedValue({
      data: { pairs: [{ chainId: 'ethereum' }, { chainId: 'solana' }] },
    });
    await expect(fetchPools('url', '0xABCD')).rejects.toThrow('ethereum, solana');
  });

  test('constructs correct URL', async () => {
    client.get.mockResolvedValue({
      data: { pairs: [{ chainId: 'bsc', dexId: 'pancakeswap', pairAddress: 'p1' }] },
    });

    await fetchPools('https://api.dexscreener.com/latest/dex/tokens', '0xABCD1234');
    expect(client.get).toHaveBeenCalledWith(
      'https://api.dexscreener.com/latest/dex/tokens/0xABCD1234',
      expect.any(Object)
    );
  });
});
