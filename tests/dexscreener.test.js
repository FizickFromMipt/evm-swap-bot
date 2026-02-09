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

  test('returns only solana pairs', async () => {
    client.get.mockResolvedValue({
      data: {
        pairs: [
          { chainId: 'solana', dexId: 'raydium', pairAddress: 'p1' },
          { chainId: 'ethereum', dexId: 'uniswap', pairAddress: 'p2' },
          { chainId: 'solana', dexId: 'orca', pairAddress: 'p3' },
          { chainId: 'bsc', dexId: 'pancakeswap', pairAddress: 'p4' },
        ],
      },
    });

    const pools = await fetchPools('https://api.dexscreener.com/latest/dex/tokens', 'mint123');
    expect(pools).toHaveLength(2);
    expect(pools.every((p) => p.chainId === 'solana')).toBe(true);
  });

  test('throws when API returns no pairs field', async () => {
    client.get.mockResolvedValue({ data: {} });
    await expect(fetchPools('url', 'mint')).rejects.toThrow('no pairs');
  });

  test('throws when API returns null data', async () => {
    client.get.mockResolvedValue({ data: null });
    await expect(fetchPools('url', 'mint')).rejects.toThrow('no pairs');
  });

  test('throws when no solana pairs exist', async () => {
    client.get.mockResolvedValue({
      data: { pairs: [{ chainId: 'ethereum' }, { chainId: 'bsc' }] },
    });
    await expect(fetchPools('url', 'mint')).rejects.toThrow('No Solana pools');
  });

  test('error message lists available chains', async () => {
    client.get.mockResolvedValue({
      data: { pairs: [{ chainId: 'ethereum' }, { chainId: 'bsc' }] },
    });
    await expect(fetchPools('url', 'mint')).rejects.toThrow('ethereum, bsc');
  });

  test('constructs correct URL', async () => {
    client.get.mockResolvedValue({
      data: { pairs: [{ chainId: 'solana', dexId: 'raydium', pairAddress: 'p1' }] },
    });

    await fetchPools('https://api.dexscreener.com/latest/dex/tokens', 'ABC123');
    expect(client.get).toHaveBeenCalledWith(
      'https://api.dexscreener.com/latest/dex/tokens/ABC123',
      expect.any(Object)
    );
  });
});
