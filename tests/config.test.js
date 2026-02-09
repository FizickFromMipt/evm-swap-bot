const { bnbToWei, loadConfig, createSafeConfig } = require('../src/config');

describe('bnbToWei', () => {
  test('converts 1 BNB', () => {
    expect(bnbToWei('1')).toBe(1_000_000_000_000_000_000n);
  });

  test('converts 0.01 BNB', () => {
    expect(bnbToWei('0.01')).toBe(10_000_000_000_000_000n);
  });

  test('converts 0.5 BNB', () => {
    expect(bnbToWei('0.5')).toBe(500_000_000_000_000_000n);
  });

  test('handles trailing dot', () => {
    expect(bnbToWei('1.')).toBe(1_000_000_000_000_000_000n);
  });

  test('handles 18-decimal precision', () => {
    expect(bnbToWei('0.000000000000000001')).toBe(1n);
  });

  test('truncates beyond 18 decimals', () => {
    expect(bnbToWei('0.0000000000000000019')).toBe(1n);
  });

  test('converts whole number without decimals', () => {
    expect(bnbToWei('10')).toBe(10_000_000_000_000_000_000n);
  });

  test('converts 0', () => {
    expect(bnbToWei('0')).toBe(0n);
  });

  test('handles leading-dot format .5', () => {
    expect(bnbToWei('.5')).toBe(500_000_000_000_000_000n);
  });

  test('handles leading-dot format .001', () => {
    expect(bnbToWei('.001')).toBe(1_000_000_000_000_000n);
  });
});

describe('createSafeConfig', () => {
  test('redacts wallet in toJSON', () => {
    const mockWallet = { address: '0xABCD1234567890abcdef1234567890abcdef1234' };
    const config = createSafeConfig({ wallet: mockWallet, rpcUrl: 'http://test' });
    const json = config.toJSON();
    expect(json.wallet).toContain('[Wallet:');
    expect(json.wallet).toContain('0xABCD1234567890abcdef1234567890abcdef1234');
    expect(json.rpcUrl).toBe('http://test');
  });

  test('handles missing wallet', () => {
    const config = createSafeConfig({ rpcUrl: 'http://test' });
    const json = config.toJSON();
    expect(json.wallet).toBeUndefined();
  });

  test('wallet still accessible on config object', () => {
    const mockWallet = { address: '0xABCD1234567890abcdef1234567890abcdef1234' };
    const config = createSafeConfig({ wallet: mockWallet });
    expect(config.wallet.address).toBe('0xABCD1234567890abcdef1234567890abcdef1234');
  });
});

describe('loadConfig', () => {
  const originalEnv = process.env;
  // Known hardhat test private key
  const TEST_PRIVATE_KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.RPC_URL;
    delete process.env.PRIVATE_KEY;
    delete process.env.PRIVATE_KEY_PATH;
    delete process.env.BUY_AMOUNT_BNB;
    delete process.env.SLIPPAGE_PERCENT;
    delete process.env.GAS_LIMIT;
    delete process.env.MAX_GAS_PRICE_GWEI;
    delete process.env.MAX_BUY_BNB;
    delete process.env.ROUTER_ZERO_X_API_KEY;
    delete process.env.ZEROX_API_URL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('throws on missing RPC_URL', () => {
    process.env.PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.BUY_AMOUNT_BNB = '0.01';
    process.env.ROUTER_ZERO_X_API_KEY = 'test-key';
    const { loadConfig: lc } = require('../src/config');
    expect(() => lc()).toThrow('RPC_URL is required');
  });

  test('throws on missing PRIVATE_KEY', () => {
    process.env.RPC_URL = 'http://localhost:8545';
    process.env.BUY_AMOUNT_BNB = '0.01';
    process.env.ROUTER_ZERO_X_API_KEY = 'test-key';
    const { loadConfig: lc } = require('../src/config');
    expect(() => lc()).toThrow('PRIVATE_KEY or PRIVATE_KEY_PATH is required');
  });

  test('throws on missing BUY_AMOUNT_BNB', () => {
    process.env.RPC_URL = 'http://localhost:8545';
    process.env.PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.ROUTER_ZERO_X_API_KEY = 'test-key';
    const { loadConfig: lc } = require('../src/config');
    expect(() => lc()).toThrow('BUY_AMOUNT_BNB must be a valid number');
  });

  test('throws on BUY_AMOUNT_BNB = 0', () => {
    process.env.RPC_URL = 'http://localhost:8545';
    process.env.PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.BUY_AMOUNT_BNB = '0';
    process.env.ROUTER_ZERO_X_API_KEY = 'test-key';
    const { loadConfig: lc } = require('../src/config');
    expect(() => lc()).toThrow('greater than 0');
  });

  test('throws on BUY_AMOUNT_BNB exceeding MAX_BUY_BNB', () => {
    process.env.RPC_URL = 'http://localhost:8545';
    process.env.PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.BUY_AMOUNT_BNB = '5';
    process.env.MAX_BUY_BNB = '1';
    process.env.ROUTER_ZERO_X_API_KEY = 'test-key';
    const { loadConfig: lc } = require('../src/config');
    expect(() => lc()).toThrow('exceeds MAX_BUY_BNB');
  });

  test('throws on SLIPPAGE_PERCENT > 50', () => {
    process.env.RPC_URL = 'http://localhost:8545';
    process.env.PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.BUY_AMOUNT_BNB = '0.01';
    process.env.SLIPPAGE_PERCENT = '60';
    process.env.ROUTER_ZERO_X_API_KEY = 'test-key';
    const { loadConfig: lc } = require('../src/config');
    expect(() => lc()).toThrow('50%');
  });

  test('throws on missing ROUTER_ZERO_X_API_KEY', () => {
    process.env.RPC_URL = 'http://localhost:8545';
    process.env.PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.BUY_AMOUNT_BNB = '0.01';
    const { loadConfig: lc } = require('../src/config');
    expect(() => lc()).toThrow('ROUTER_ZERO_X_API_KEY is required');
  });

  test('collects multiple errors', () => {
    const { loadConfig: lc } = require('../src/config');
    try {
      lc();
    } catch (err) {
      expect(err.message).toContain('RPC_URL is required');
      expect(err.message).toContain('PRIVATE_KEY or PRIVATE_KEY_PATH is required');
    }
  });

  test('successful load with valid config', () => {
    process.env.RPC_URL = 'http://localhost:8545';
    process.env.PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.BUY_AMOUNT_BNB = '0.01';
    process.env.ROUTER_ZERO_X_API_KEY = 'test-key';
    const { loadConfig: lc } = require('../src/config');
    const config = lc();
    expect(config.rpcUrl).toBe('http://localhost:8545');
    expect(config.buyAmountBnb).toBe('0.01');
    expect(config.buyAmountWei).toBe(10_000_000_000_000_000n);
    expect(config.wallet).toBeDefined();
    expect(config.wallet.address).toBeDefined();
  });

  test('normalizes private key without 0x prefix', () => {
    process.env.RPC_URL = 'http://localhost:8545';
    process.env.PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.BUY_AMOUNT_BNB = '0.01';
    process.env.ROUTER_ZERO_X_API_KEY = 'test-key';
    const { loadConfig: lc } = require('../src/config');
    const config = lc();
    expect(config.wallet.address).toBeDefined();
  });

  test('handles 0x-prefixed private key', () => {
    process.env.RPC_URL = 'http://localhost:8545';
    process.env.PRIVATE_KEY = '0x' + TEST_PRIVATE_KEY;
    process.env.BUY_AMOUNT_BNB = '0.01';
    process.env.ROUTER_ZERO_X_API_KEY = 'test-key';
    const { loadConfig: lc } = require('../src/config');
    const config = lc();
    expect(config.wallet.address).toBeDefined();
  });

  test('throws on invalid PRIVATE_KEY', () => {
    process.env.RPC_URL = 'http://localhost:8545';
    process.env.PRIVATE_KEY = 'not-a-valid-key';
    process.env.BUY_AMOUNT_BNB = '0.01';
    process.env.ROUTER_ZERO_X_API_KEY = 'test-key';
    const { loadConfig: lc } = require('../src/config');
    expect(() => lc()).toThrow('Failed to parse PRIVATE_KEY');
  });

  test('uses default slippage of 5 when not set', () => {
    process.env.RPC_URL = 'http://localhost:8545';
    process.env.PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.BUY_AMOUNT_BNB = '0.01';
    process.env.ROUTER_ZERO_X_API_KEY = 'test-key';
    delete process.env.SLIPPAGE_PERCENT;
    const { loadConfig: lc } = require('../src/config');
    const config = lc();
    expect(config.slippagePercent).toBe(5);
  });

  test('config includes BSC and 0x constants', () => {
    process.env.RPC_URL = 'http://localhost:8545';
    process.env.PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.BUY_AMOUNT_BNB = '0.01';
    process.env.ROUTER_ZERO_X_API_KEY = 'my-0x-key';
    const { loadConfig: lc } = require('../src/config');
    const config = lc();
    expect(config.wbnb).toBe('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c');
    expect(config.routerZeroxApiKey).toBe('my-0x-key');
    expect(config.zeroxApiUrl).toBe('https://api.0x.org');
    expect(config.nativeToken).toBe('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE');
  });

  test('slippageBps is correctly computed from slippagePercent', () => {
    process.env.RPC_URL = 'http://localhost:8545';
    process.env.PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.BUY_AMOUNT_BNB = '0.01';
    process.env.ROUTER_ZERO_X_API_KEY = 'test-key';
    process.env.SLIPPAGE_PERCENT = '5.5';
    const { loadConfig: lc } = require('../src/config');
    const config = lc();
    expect(config.slippageBps).toBe(550);
  });

  test('slippageBps defaults to 500 (5%)', () => {
    process.env.RPC_URL = 'http://localhost:8545';
    process.env.PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.BUY_AMOUNT_BNB = '0.01';
    process.env.ROUTER_ZERO_X_API_KEY = 'test-key';
    const { loadConfig: lc } = require('../src/config');
    const config = lc();
    expect(config.slippageBps).toBe(500);
  });

  test('uses custom ZEROX_API_URL when set', () => {
    process.env.RPC_URL = 'http://localhost:8545';
    process.env.PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.BUY_AMOUNT_BNB = '0.01';
    process.env.ROUTER_ZERO_X_API_KEY = 'test-key';
    process.env.ZEROX_API_URL = 'https://custom.api.0x.org';
    const { loadConfig: lc } = require('../src/config');
    const config = lc();
    expect(config.zeroxApiUrl).toBe('https://custom.api.0x.org');
  });
});
