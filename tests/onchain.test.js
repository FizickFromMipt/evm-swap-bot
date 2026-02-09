jest.mock('../src/logger', () => ({
  step: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  sep: jest.fn(),
}));

const { PublicKey } = require('@solana/web3.js');
const { validateTokenMint, validatePoolAccount, parseMintData } = require('../src/onchain');
const logger = require('../src/logger');

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// Helper: build a valid 82-byte SPL Mint buffer
function buildMintBuffer({
  mintAuthority = null,
  supply = 1_000_000_000n,
  decimals = 9,
  isInitialized = true,
  freezeAuthority = null,
} = {}) {
  const buf = Buffer.alloc(82, 0);

  // mintAuthorityOption (u32 LE) + mintAuthority (32 bytes)
  if (mintAuthority) {
    buf.writeUInt32LE(1, 0);
    new PublicKey(mintAuthority).toBuffer().copy(buf, 4);
  }

  // supply (u64 LE at offset 36)
  buf.writeBigUInt64LE(supply, 36);

  // decimals (u8 at offset 44)
  buf[44] = decimals;

  // isInitialized (bool at offset 45)
  buf[45] = isInitialized ? 1 : 0;

  // freezeAuthorityOption (u32 LE at offset 46) + freezeAuthority (32 bytes at offset 50)
  if (freezeAuthority) {
    buf.writeUInt32LE(1, 46);
    new PublicKey(freezeAuthority).toBuffer().copy(buf, 50);
  }

  return buf;
}

function mockConnection(getAccountInfoResult) {
  return {
    getAccountInfo: jest.fn().mockResolvedValue(getAccountInfoResult),
  };
}

const SOME_PUBKEY = PublicKey.default.toBase58(); // 11111111111111111111111111111111

// ============= parseMintData =============

describe('parseMintData', () => {
  test('parses valid mint data', () => {
    const data = buildMintBuffer({ supply: 500_000n, decimals: 6 });
    const result = parseMintData(data);

    expect(result.supply).toBe('500000');
    expect(result.decimals).toBe(6);
    expect(result.isInitialized).toBe(true);
    expect(result.hasMintAuthority).toBe(false);
    expect(result.hasFreezeAuthority).toBe(false);
  });

  test('parses mint with mint authority set', () => {
    const auth = PublicKey.default.toBase58();
    const data = buildMintBuffer({ mintAuthority: auth });
    const result = parseMintData(data);

    expect(result.hasMintAuthority).toBe(true);
    expect(result.mintAuthority).toBe(auth);
  });

  test('parses mint with freeze authority set', () => {
    const auth = PublicKey.default.toBase58();
    const data = buildMintBuffer({ freezeAuthority: auth });
    const result = parseMintData(data);

    expect(result.hasFreezeAuthority).toBe(true);
    expect(result.freezeAuthority).toBe(auth);
  });

  test('returns null for buffer shorter than 82 bytes', () => {
    expect(parseMintData(Buffer.alloc(50))).toBeNull();
  });

  test('returns null for null/undefined', () => {
    expect(parseMintData(null)).toBeNull();
    expect(parseMintData(undefined)).toBeNull();
  });

  test('detects uninitialized mint', () => {
    const data = buildMintBuffer({ isInitialized: false });
    const result = parseMintData(data);
    expect(result.isInitialized).toBe(false);
  });
});

// ============= validateTokenMint =============

describe('validateTokenMint', () => {
  beforeEach(() => jest.clearAllMocks());

  test('valid token with no risk flags', async () => {
    const data = buildMintBuffer({ supply: 1_000_000_000n, decimals: 9 });
    const conn = mockConnection({
      owner: new PublicKey(TOKEN_PROGRAM_ID),
      data,
      lamports: 1_000_000,
    });

    const result = await validateTokenMint(conn, SOME_PUBKEY);

    expect(result.valid).toBe(true);
    expect(result.supply).toBe('1000000000');
    expect(result.decimals).toBe(9);
    expect(result.warnings).toHaveLength(0);
    expect(result.isToken2022).toBe(false);
  });

  test('valid Token-2022 token', async () => {
    const data = buildMintBuffer();
    const conn = mockConnection({
      owner: new PublicKey(TOKEN_2022_PROGRAM_ID),
      data,
      lamports: 1_000_000,
    });

    const result = await validateTokenMint(conn, SOME_PUBKEY);

    expect(result.valid).toBe(true);
    expect(result.isToken2022).toBe(true);
  });

  test('warns on freeze authority', async () => {
    const data = buildMintBuffer({ freezeAuthority: SOME_PUBKEY });
    const conn = mockConnection({
      owner: new PublicKey(TOKEN_PROGRAM_ID),
      data,
      lamports: 1_000_000,
    });

    const result = await validateTokenMint(conn, SOME_PUBKEY);

    expect(result.valid).toBe(true);
    expect(result.hasFreezeAuthority).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes('Freeze authority'))).toBe(true);
  });

  test('warns on mint authority', async () => {
    const data = buildMintBuffer({ mintAuthority: SOME_PUBKEY });
    const conn = mockConnection({
      owner: new PublicKey(TOKEN_PROGRAM_ID),
      data,
      lamports: 1_000_000,
    });

    const result = await validateTokenMint(conn, SOME_PUBKEY);

    expect(result.valid).toBe(true);
    expect(result.hasMintAuthority).toBe(true);
    expect(result.warnings.some((w) => w.includes('Mint authority'))).toBe(true);
  });

  test('warns on zero supply', async () => {
    const data = buildMintBuffer({ supply: 0n });
    const conn = mockConnection({
      owner: new PublicKey(TOKEN_PROGRAM_ID),
      data,
      lamports: 1_000_000,
    });

    const result = await validateTokenMint(conn, SOME_PUBKEY);

    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes('zero supply'))).toBe(true);
  });

  test('rejects when account does not exist', async () => {
    const conn = mockConnection(null);
    const result = await validateTokenMint(conn, SOME_PUBKEY);

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('does not exist');
  });

  test('rejects when account is not an SPL token', async () => {
    const data = buildMintBuffer();
    const conn = mockConnection({
      owner: new PublicKey('11111111111111111111111111111111'), // System Program
      data,
      lamports: 1_000_000,
    });

    const result = await validateTokenMint(conn, SOME_PUBKEY);

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not an SPL token');
  });

  test('rejects when mint is not initialized', async () => {
    const data = buildMintBuffer({ isInitialized: false });
    const conn = mockConnection({
      owner: new PublicKey(TOKEN_PROGRAM_ID),
      data,
      lamports: 1_000_000,
    });

    const result = await validateTokenMint(conn, SOME_PUBKEY);

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not initialized');
  });

  test('rejects when data is too short', async () => {
    const conn = mockConnection({
      owner: new PublicKey(TOKEN_PROGRAM_ID),
      data: Buffer.alloc(10),
      lamports: 1_000_000,
    });

    const result = await validateTokenMint(conn, SOME_PUBKEY);

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('too short');
  });

  test('rejects invalid public key format', async () => {
    const conn = mockConnection(null);
    const result = await validateTokenMint(conn, 'not-a-valid-key!!!');

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Invalid public key');
  });

  test('logs warnings to logger', async () => {
    const data = buildMintBuffer({
      freezeAuthority: SOME_PUBKEY,
      mintAuthority: SOME_PUBKEY,
    });
    const conn = mockConnection({
      owner: new PublicKey(TOKEN_PROGRAM_ID),
      data,
      lamports: 1_000_000,
    });

    await validateTokenMint(conn, SOME_PUBKEY);

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Freeze authority'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Mint authority'));
  });

  test('accumulates multiple warnings', async () => {
    const data = buildMintBuffer({
      supply: 0n,
      freezeAuthority: SOME_PUBKEY,
      mintAuthority: SOME_PUBKEY,
    });
    const conn = mockConnection({
      owner: new PublicKey(TOKEN_PROGRAM_ID),
      data,
      lamports: 1_000_000,
    });

    const result = await validateTokenMint(conn, SOME_PUBKEY);

    expect(result.warnings).toHaveLength(3);
  });
});

// ============= validatePoolAccount =============

describe('validatePoolAccount', () => {
  test('returns exists:true for existing account', async () => {
    const conn = mockConnection({
      owner: new PublicKey(SOME_PUBKEY),
      data: Buffer.alloc(200),
      lamports: 5_000_000,
    });

    const result = await validatePoolAccount(conn, SOME_PUBKEY);

    expect(result.exists).toBe(true);
    expect(result.dataSize).toBe(200);
    expect(result.lamports).toBe(5_000_000);
  });

  test('returns exists:false when account not found', async () => {
    const conn = mockConnection(null);
    const result = await validatePoolAccount(conn, SOME_PUBKEY);

    expect(result.exists).toBe(false);
    expect(result.reason).toContain('does not exist');
  });

  test('returns exists:false for invalid address', async () => {
    const conn = mockConnection(null);
    const result = await validatePoolAccount(conn, '!!!invalid!!!');

    expect(result.exists).toBe(false);
    expect(result.reason).toContain('Invalid pool address');
  });
});
