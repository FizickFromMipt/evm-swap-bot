const fs = require('fs');
const path = require('path');
const os = require('os');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');

describe('solToLamports', () => {
  let solToLamports;

  beforeAll(() => {
    ({ solToLamports } = require('../src/config'));
  });

  test('converts 1 SOL', () => {
    expect(solToLamports('1')).toBe(1_000_000_000);
  });

  test('converts 0.01 SOL', () => {
    expect(solToLamports('0.01')).toBe(10_000_000);
  });

  test('converts 0.001 SOL', () => {
    expect(solToLamports('0.001')).toBe(1_000_000);
  });

  test('converts 0.29 SOL without float rounding error', () => {
    // 0.29 * 1e9 in float = 289999999.99999997 — old code would floor to 289999999
    expect(solToLamports('0.29')).toBe(290_000_000);
  });

  test('converts 0.000000001 SOL (1 lamport)', () => {
    expect(solToLamports('0.000000001')).toBe(1);
  });

  test('converts 1.5 SOL', () => {
    expect(solToLamports('1.5')).toBe(1_500_000_000);
  });

  test('converts 10 SOL', () => {
    expect(solToLamports('10')).toBe(10_000_000_000);
  });

  test('truncates beyond 9 decimal places', () => {
    expect(solToLamports('0.0000000019')).toBe(1); // 10th digit ignored
  });

  test('handles leading-dot format .5 (BUG-1 regression)', () => {
    expect(solToLamports('.5')).toBe(500_000_000);
  });

  test('handles leading-dot format .001', () => {
    expect(solToLamports('.001')).toBe(1_000_000);
  });

  test('handles trailing-dot format 5.', () => {
    expect(solToLamports('5.')).toBe(5_000_000_000);
  });
});

describe('loadConfig', () => {
  const originalEnv = { ...process.env };
  let testKeypair;
  let testKeyBase58;

  beforeAll(() => {
    testKeypair = Keypair.generate();
    testKeyBase58 = bs58.encode(testKeypair.secretKey);
  });

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    // Set valid defaults
    process.env.SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';
    process.env.PRIVATE_KEY = testKeyBase58;
    process.env.BUY_AMOUNT_SOL = '0.01';
    process.env.SLIPPAGE_BPS = '500';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('loads valid config', () => {
    const { loadConfig } = require('../src/config');
    const config = loadConfig();

    expect(config.rpcUrl).toBe('https://api.mainnet-beta.solana.com');
    expect(config.buyAmountSol).toBe('0.01');
    expect(config.amountLamports).toBe(10_000_000);
    expect(config.slippageBps).toBe(500);
    expect(config.keypair.publicKey.toBase58()).toBe(testKeypair.publicKey.toBase58());
  });

  test('accepts private key as JSON array', () => {
    process.env.PRIVATE_KEY = JSON.stringify(Array.from(testKeypair.secretKey));
    const { loadConfig } = require('../src/config');
    const config = loadConfig();
    expect(config.keypair.publicKey.toBase58()).toBe(testKeypair.publicKey.toBase58());
  });

  test('throws on missing SOLANA_RPC_URL', () => {
    delete process.env.SOLANA_RPC_URL;
    const { loadConfig } = require('../src/config');
    expect(() => loadConfig()).toThrow('SOLANA_RPC_URL');
  });

  test('throws on missing PRIVATE_KEY', () => {
    delete process.env.PRIVATE_KEY;
    const { loadConfig } = require('../src/config');
    expect(() => loadConfig()).toThrow('PRIVATE_KEY');
  });

  test('throws on missing BUY_AMOUNT_SOL', () => {
    delete process.env.BUY_AMOUNT_SOL;
    const { loadConfig } = require('../src/config');
    expect(() => loadConfig()).toThrow('BUY_AMOUNT_SOL');
  });

  test('throws on BUY_AMOUNT_SOL = 0', () => {
    process.env.BUY_AMOUNT_SOL = '0';
    const { loadConfig } = require('../src/config');
    expect(() => loadConfig()).toThrow('greater than 0');
  });

  test('throws on BUY_AMOUNT_SOL exceeding MAX_BUY_SOL', () => {
    process.env.BUY_AMOUNT_SOL = '15';
    process.env.MAX_BUY_SOL = '10';
    const { loadConfig } = require('../src/config');
    expect(() => loadConfig()).toThrow('exceeds MAX_BUY_SOL');
  });

  test('allows BUY_AMOUNT_SOL when MAX_BUY_SOL is raised', () => {
    process.env.BUY_AMOUNT_SOL = '15';
    process.env.MAX_BUY_SOL = '100';
    const { loadConfig } = require('../src/config');
    expect(() => loadConfig()).not.toThrow();
  });

  test('throws on SLIPPAGE_BPS > 5000', () => {
    process.env.SLIPPAGE_BPS = '6000';
    const { loadConfig } = require('../src/config');
    expect(() => loadConfig()).toThrow('5000');
  });

  test('throws on negative SLIPPAGE_BPS', () => {
    process.env.SLIPPAGE_BPS = '-100';
    const { loadConfig } = require('../src/config');
    expect(() => loadConfig()).toThrow('non-negative');
  });

  test('uses default slippage of 500 when not set', () => {
    delete process.env.SLIPPAGE_BPS;
    const { loadConfig } = require('../src/config');
    const config = loadConfig();
    expect(config.slippageBps).toBe(500);
  });

  test('throws on invalid PRIVATE_KEY', () => {
    process.env.PRIVATE_KEY = 'not-a-valid-key';
    const { loadConfig } = require('../src/config');
    expect(() => loadConfig()).toThrow('Failed to parse PRIVATE_KEY');
  });

  test('loads key from PRIVATE_KEY_PATH file', () => {
    delete process.env.PRIVATE_KEY;
    const tmpFile = path.join(os.tmpdir(), `test-key-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, testKeyBase58);
    process.env.PRIVATE_KEY_PATH = tmpFile;

    try {
      const { loadConfig } = require('../src/config');
      const config = loadConfig();
      expect(config.keypair.publicKey.toBase58()).toBe(testKeypair.publicKey.toBase58());
    } finally {
      fs.unlinkSync(tmpFile);
      delete process.env.PRIVATE_KEY_PATH;
    }
  });

  test('throws when PRIVATE_KEY_PATH file does not exist', () => {
    delete process.env.PRIVATE_KEY;
    process.env.PRIVATE_KEY_PATH = '/nonexistent/path/key.json';

    const { loadConfig } = require('../src/config');
    expect(() => loadConfig()).toThrow('not found');

    delete process.env.PRIVATE_KEY_PATH;
  });

  test('throws when both PRIVATE_KEY and PRIVATE_KEY_PATH are set', () => {
    process.env.PRIVATE_KEY_PATH = '/some/path';

    const { loadConfig } = require('../src/config');
    expect(() => loadConfig()).toThrow('Use only one');

    delete process.env.PRIVATE_KEY_PATH;
  });
});

// === Safe config serialization ===

describe('createSafeConfig', () => {
  test('redacts keypair from JSON.stringify', () => {
    const { createSafeConfig } = require('../src/config');
    const keypair = Keypair.generate();
    const config = createSafeConfig({ keypair, rpcUrl: 'http://test' });

    const json = JSON.stringify(config);
    const parsed = JSON.parse(json);

    // Must NOT contain secretKey bytes
    expect(json).not.toContain('secretKey');
    expect(parsed.keypair).toContain('[Keypair:');
    expect(parsed.keypair).toContain(keypair.publicKey.toBase58());
    expect(parsed.rpcUrl).toBe('http://test');
  });

  test('config.keypair still works as actual Keypair', () => {
    const { createSafeConfig } = require('../src/config');
    const keypair = Keypair.generate();
    const config = createSafeConfig({ keypair });

    // Can still use keypair normally
    expect(config.keypair.publicKey.toBase58()).toBe(keypair.publicKey.toBase58());
    expect(config.keypair.secretKey).toEqual(keypair.secretKey);
  });
});

// === Network detection ===

describe('detectNetwork', () => {
  test('detects mainnet-beta', async () => {
    const { detectNetwork } = require('../src/config');
    const conn = {
      getGenesisHash: jest.fn().mockResolvedValue('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'),
    };
    expect(await detectNetwork(conn)).toBe('mainnet-beta');
  });

  test('detects devnet', async () => {
    const { detectNetwork } = require('../src/config');
    const conn = {
      getGenesisHash: jest.fn().mockResolvedValue('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'),
    };
    expect(await detectNetwork(conn)).toBe('devnet');
  });

  test('detects testnet', async () => {
    const { detectNetwork } = require('../src/config');
    const conn = {
      getGenesisHash: jest.fn().mockResolvedValue('4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z'),
    };
    expect(await detectNetwork(conn)).toBe('testnet');
  });

  test('returns unknown for unrecognized hash', async () => {
    const { detectNetwork } = require('../src/config');
    const conn = {
      getGenesisHash: jest.fn().mockResolvedValue('SomeLocalValidatorHash'),
    };
    expect(await detectNetwork(conn)).toBe('unknown');
  });

  test('returns unknown on RPC error', async () => {
    const { detectNetwork } = require('../src/config');
    const conn = {
      getGenesisHash: jest.fn().mockRejectedValue(new Error('RPC down')),
    };
    expect(await detectNetwork(conn)).toBe('unknown');
  });
});
