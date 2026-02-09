jest.mock('../src/logger', () => ({
  step: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  sep: jest.fn(),
}));

jest.mock('../src/retry', () => ({
  withRetry: jest.fn((fn) => fn()),
}));

jest.mock('../src/http', () => ({
  client: {
    get: jest.fn(),
  },
}));

const { PublicKey } = require('@solana/web3.js');
const {
  parseToken2022Extensions,
  checkTransferFee,
  checkPermanentDelegate,
  checkNonTransferable,
  checkTransferHook,
  checkHoneypot,
  runAntiScamChecks,
} = require('../src/antiscam');
const { client } = require('../src/http');

// ============= Helpers =============

/**
 * Build a Token-2022 mint buffer with extensions.
 * 82 bytes base mint + 1 byte account type (2) + TLV extensions.
 */
function buildToken2022Buffer(extensions = []) {
  // Calculate total size
  let extSize = 0;
  for (const ext of extensions) {
    extSize += 4 + ext.data.length; // 2 bytes type + 2 bytes length + data
  }

  const buf = Buffer.alloc(83 + extSize, 0);

  // Minimal valid mint data (82 bytes)
  buf.writeBigUInt64LE(1_000_000_000n, 36); // supply
  buf[44] = 9; // decimals
  buf[45] = 1; // isInitialized

  // Account type at byte 82 = 2 (Mint)
  buf[82] = 2;

  // Write TLV extensions
  let offset = 83;
  for (const ext of extensions) {
    buf.writeUInt16LE(ext.type, offset);
    buf.writeUInt16LE(ext.data.length, offset + 2);
    ext.data.copy(buf, offset + 4);
    offset += 4 + ext.data.length;
  }

  return buf;
}

/**
 * Build TransferFeeConfig extension data (108 bytes).
 */
function buildTransferFeeData({ feeBps = 0, maxFee = 0n } = {}) {
  const data = Buffer.alloc(108, 0);
  // newerTransferFee.maxFee at offset 98 (u64 LE)
  data.writeBigUInt64LE(maxFee, 98);
  // newerTransferFee.transfer_fee_basis_points at offset 106 (u16 LE)
  data.writeUInt16LE(feeBps, 106);
  return data;
}

/**
 * Build PermanentDelegate extension data (32 bytes).
 */
function buildPermanentDelegateData(pubkeyBase58) {
  const data = Buffer.alloc(32, 0);
  new PublicKey(pubkeyBase58).toBuffer().copy(data, 0);
  return data;
}

/**
 * Build TransferHook extension data (32 bytes).
 */
function buildTransferHookData(programIdBase58) {
  const data = Buffer.alloc(32, 0);
  new PublicKey(programIdBase58).toBuffer().copy(data, 0);
  return data;
}

const SOME_PUBKEY = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC mint (valid pubkey)

// ============= parseToken2022Extensions =============

describe('parseToken2022Extensions', () => {
  test('returns empty array for null data', () => {
    expect(parseToken2022Extensions(null)).toEqual([]);
  });

  test('returns empty array for data <= 83 bytes', () => {
    expect(parseToken2022Extensions(Buffer.alloc(83))).toEqual([]);
  });

  test('returns empty array if byte 82 is not 2', () => {
    const buf = Buffer.alloc(100, 0);
    buf[82] = 1; // Not a Mint account type
    expect(parseToken2022Extensions(buf)).toEqual([]);
  });

  test('parses single extension', () => {
    const extData = Buffer.alloc(10, 0xAB);
    const buf = buildToken2022Buffer([{ type: 5, data: extData }]);
    const extensions = parseToken2022Extensions(buf);

    expect(extensions).toHaveLength(1);
    expect(extensions[0].type).toBe(5);
    expect(extensions[0].data.length).toBe(10);
  });

  test('parses multiple extensions', () => {
    const ext1Data = Buffer.alloc(8, 0x01);
    const ext2Data = Buffer.alloc(32, 0x02);
    const buf = buildToken2022Buffer([
      { type: 1, data: ext1Data },
      { type: 9, data: ext2Data },
    ]);
    const extensions = parseToken2022Extensions(buf);

    expect(extensions).toHaveLength(2);
    expect(extensions[0].type).toBe(1);
    expect(extensions[1].type).toBe(9);
  });

  test('stops parsing on truncated extension', () => {
    // Build buffer with one valid extension, then truncate
    const extData = Buffer.alloc(10, 0xAB);
    const buf = buildToken2022Buffer([{ type: 5, data: extData }]);
    // Manually add a partial TLV header that claims more data than available
    const truncated = Buffer.alloc(buf.length + 4, 0);
    buf.copy(truncated);
    truncated.writeUInt16LE(99, buf.length);     // type
    truncated.writeUInt16LE(1000, buf.length + 2); // length > remaining
    const extensions = parseToken2022Extensions(truncated);

    // Should still parse the first extension, but stop at the truncated one
    expect(extensions).toHaveLength(1);
  });
});

// ============= checkTransferFee =============

describe('checkTransferFee', () => {
  test('returns null when no TransferFeeConfig extension', () => {
    expect(checkTransferFee([])).toBeNull();
  });

  test('returns null when extension data too short', () => {
    const extensions = [{ type: 1, data: Buffer.alloc(50) }];
    expect(checkTransferFee(extensions)).toBeNull();
  });

  test('detects non-zero transfer fee', () => {
    const data = buildTransferFeeData({ feeBps: 500, maxFee: 1000000n });
    const extensions = [{ type: 1, data }];
    const result = checkTransferFee(extensions);

    expect(result).not.toBeNull();
    expect(result.hasTransferFee).toBe(true);
    expect(result.feeBps).toBe(500);
    expect(result.maxFee).toBe('1000000');
  });

  test('returns hasTransferFee:false when fee is 0', () => {
    const data = buildTransferFeeData({ feeBps: 0 });
    const extensions = [{ type: 1, data }];
    const result = checkTransferFee(extensions);

    expect(result).not.toBeNull();
    expect(result.hasTransferFee).toBe(false);
    expect(result.feeBps).toBe(0);
  });
});

// ============= checkPermanentDelegate =============

describe('checkPermanentDelegate', () => {
  test('returns null when no PermanentDelegate extension', () => {
    expect(checkPermanentDelegate([])).toBeNull();
  });

  test('returns null when extension data too short', () => {
    const extensions = [{ type: 12, data: Buffer.alloc(16) }];
    expect(checkPermanentDelegate(extensions)).toBeNull();
  });

  test('returns null when delegate is default (zero) pubkey', () => {
    const data = buildPermanentDelegateData(PublicKey.default.toBase58());
    const extensions = [{ type: 12, data }];
    expect(checkPermanentDelegate(extensions)).toBeNull();
  });

  test('detects active permanent delegate', () => {
    const data = buildPermanentDelegateData(SOME_PUBKEY);
    const extensions = [{ type: 12, data }];
    const result = checkPermanentDelegate(extensions);

    expect(result).not.toBeNull();
    expect(result.hasPermanentDelegate).toBe(true);
    expect(result.delegate).toBe(SOME_PUBKEY);
  });
});

// ============= checkNonTransferable =============

describe('checkNonTransferable', () => {
  test('returns false when no NonTransferable extension', () => {
    expect(checkNonTransferable([])).toBe(false);
  });

  test('returns true when NonTransferable extension present', () => {
    const extensions = [{ type: 9, data: Buffer.alloc(0) }];
    expect(checkNonTransferable(extensions)).toBe(true);
  });

  test('returns true even among other extensions', () => {
    const extensions = [
      { type: 1, data: Buffer.alloc(108) },
      { type: 9, data: Buffer.alloc(0) },
      { type: 14, data: Buffer.alloc(32) },
    ];
    expect(checkNonTransferable(extensions)).toBe(true);
  });
});

// ============= checkTransferHook =============

describe('checkTransferHook', () => {
  test('returns null when no TransferHook extension', () => {
    expect(checkTransferHook([])).toBeNull();
  });

  test('returns null when extension data too short', () => {
    const extensions = [{ type: 14, data: Buffer.alloc(16) }];
    expect(checkTransferHook(extensions)).toBeNull();
  });

  test('returns null when programId is default pubkey', () => {
    const data = buildTransferHookData(PublicKey.default.toBase58());
    const extensions = [{ type: 14, data }];
    expect(checkTransferHook(extensions)).toBeNull();
  });

  test('detects active transfer hook', () => {
    const data = buildTransferHookData(SOME_PUBKEY);
    const extensions = [{ type: 14, data }];
    const result = checkTransferHook(extensions);

    expect(result).not.toBeNull();
    expect(result.hasTransferHook).toBe(true);
    expect(result.programId).toBe(SOME_PUBKEY);
  });
});

// ============= checkHoneypot =============

describe('checkHoneypot', () => {
  const config = {
    jupiterApi: { quote: 'https://quote-api.jup.ag/v6/quote' },
    solMint: 'So11111111111111111111111111111111111111112',
    slippageBps: 500,
    amountLamports: 10_000_000,
  };
  const buyQuote = { outAmount: '50000000' };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns canSell:true with low round-trip loss', async () => {
    client.get.mockResolvedValue({
      data: { outAmount: '9500000', priceImpactPct: '0.5' },
    });

    const result = await checkHoneypot(config, 'TokenMint123', buyQuote);

    expect(result.canSell).toBe(true);
    expect(result.sellOutAmount).toBe('9500000');
    expect(result.roundTripLossPct).toBe(5);
    expect(result.warning).toBeUndefined();
  });

  test('returns warning for >20% round-trip loss', async () => {
    client.get.mockResolvedValue({
      data: { outAmount: '7000000' },
    });

    const result = await checkHoneypot(config, 'TokenMint123', buyQuote);

    expect(result.canSell).toBe(true);
    expect(result.roundTripLossPct).toBe(30);
    expect(result.warning).toContain('High round-trip loss');
  });

  test('returns extreme warning for >50% round-trip loss', async () => {
    client.get.mockResolvedValue({
      data: { outAmount: '3000000' },
    });

    const result = await checkHoneypot(config, 'TokenMint123', buyQuote);

    expect(result.canSell).toBe(true);
    expect(result.roundTripLossPct).toBe(70);
    expect(result.warning).toContain('Extreme round-trip loss');
  });

  test('returns canSell:false when no sell route found', async () => {
    client.get.mockResolvedValue({ data: {} });

    const result = await checkHoneypot(config, 'TokenMint123', buyQuote);

    expect(result.canSell).toBe(false);
    expect(result.reason).toContain('honeypot');
  });

  test('returns canSell:false on API error', async () => {
    client.get.mockRejectedValue(new Error('Network error'));

    const result = await checkHoneypot(config, 'TokenMint123', buyQuote);

    expect(result.canSell).toBe(false);
    expect(result.reason).toContain('Sell simulation failed');
    expect(result.reason).toContain('Network error');
  });

  test('passes correct params to Jupiter API', async () => {
    client.get.mockResolvedValue({
      data: { outAmount: '9500000' },
    });

    await checkHoneypot(config, 'MyTokenMint', buyQuote);

    expect(client.get).toHaveBeenCalledWith(
      config.jupiterApi.quote,
      expect.objectContaining({
        params: {
          inputMint: 'MyTokenMint',
          outputMint: config.solMint,
          amount: '50000000',
          slippageBps: 500,
        },
      })
    );
  });
});

// ============= runAntiScamChecks =============

describe('runAntiScamChecks', () => {
  const config = {
    jupiterApi: { quote: 'https://quote-api.jup.ag/v6/quote' },
    solMint: 'So11111111111111111111111111111111111111112',
    slippageBps: 500,
    amountLamports: 10_000_000,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns low risk for clean SPL token (no Token-2022)', async () => {
    const tokenInfo = {
      isToken2022: false,
      hasFreezeAuthority: false,
      hasMintAuthority: false,
      supply: '1000000000',
    };

    // Mock honeypot check: token is sellable with low loss
    client.get.mockResolvedValue({
      data: { outAmount: '9800000' },
    });

    const result = await runAntiScamChecks(config, 'TokenMint', tokenInfo, { outAmount: '50000000' });

    expect(result.riskLevel).toBe('low');
    expect(result.warnings).toHaveLength(0);
  });

  test('returns medium risk for mint authority only', async () => {
    const tokenInfo = {
      isToken2022: false,
      hasFreezeAuthority: false,
      hasMintAuthority: true,
      supply: '1000000000',
    };

    client.get.mockResolvedValue({
      data: { outAmount: '9800000' },
    });

    const result = await runAntiScamChecks(config, 'TokenMint', tokenInfo, { outAmount: '50000000' });

    expect(result.riskLevel).toBe('medium');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Mint authority');
  });

  test('returns high risk for freeze authority', async () => {
    const tokenInfo = {
      isToken2022: false,
      hasFreezeAuthority: true,
      hasMintAuthority: false,
      supply: '1000000000',
    };

    client.get.mockResolvedValue({
      data: { outAmount: '9800000' },
    });

    const result = await runAntiScamChecks(config, 'TokenMint', tokenInfo, { outAmount: '50000000' });

    expect(result.riskLevel).toBe('high');
    expect(result.warnings.some((w) => w.includes('Freeze authority'))).toBe(true);
  });

  test('returns critical risk for honeypot (can\'t sell)', async () => {
    const tokenInfo = {
      isToken2022: false,
      hasFreezeAuthority: false,
      hasMintAuthority: false,
      supply: '1000000000',
    };

    client.get.mockResolvedValue({ data: {} });

    const result = await runAntiScamChecks(config, 'TokenMint', tokenInfo, { outAmount: '50000000' });

    expect(result.riskLevel).toBe('critical');
    expect(result.warnings.some((w) => w.includes('HONEYPOT'))).toBe(true);
  });

  test('returns critical risk for non-transferable Token-2022', async () => {
    const rawData = buildToken2022Buffer([{ type: 9, data: Buffer.alloc(0) }]);
    const tokenInfo = {
      isToken2022: true,
      _rawData: rawData,
      hasFreezeAuthority: false,
      hasMintAuthority: false,
      supply: '1000000000',
    };

    client.get.mockResolvedValue({
      data: { outAmount: '9800000' },
    });

    const result = await runAntiScamChecks(config, 'TokenMint', tokenInfo, { outAmount: '50000000' });

    expect(result.riskLevel).toBe('critical');
    expect(result.warnings.some((w) => w.includes('NON-TRANSFERABLE'))).toBe(true);
    expect(result.details.nonTransferable).toBe(true);
  });

  test('returns critical risk for permanent delegate Token-2022', async () => {
    const delegateData = buildPermanentDelegateData(SOME_PUBKEY);
    const rawData = buildToken2022Buffer([{ type: 12, data: delegateData }]);
    const tokenInfo = {
      isToken2022: true,
      _rawData: rawData,
      hasFreezeAuthority: false,
      hasMintAuthority: false,
      supply: '1000000000',
    };

    client.get.mockResolvedValue({
      data: { outAmount: '9800000' },
    });

    const result = await runAntiScamChecks(config, 'TokenMint', tokenInfo, { outAmount: '50000000' });

    expect(result.riskLevel).toBe('critical');
    expect(result.warnings.some((w) => w.includes('Permanent delegate'))).toBe(true);
    expect(result.details.permanentDelegate.delegate).toBe(SOME_PUBKEY);
  });

  test('detects extreme transfer fee on Token-2022', async () => {
    const feeData = buildTransferFeeData({ feeBps: 5000, maxFee: 0n });
    const rawData = buildToken2022Buffer([{ type: 1, data: feeData }]);
    const tokenInfo = {
      isToken2022: true,
      _rawData: rawData,
      hasFreezeAuthority: false,
      hasMintAuthority: false,
      supply: '1000000000',
    };

    client.get.mockResolvedValue({
      data: { outAmount: '9800000' },
    });

    const result = await runAntiScamChecks(config, 'TokenMint', tokenInfo, { outAmount: '50000000' });

    expect(result.riskLevel).toBe('critical');
    expect(result.warnings.some((w) => w.includes('EXTREME transfer fee'))).toBe(true);
    expect(result.details.transferFee.feeBps).toBe(5000);
  });

  test('detects transfer hook on Token-2022', async () => {
    const hookData = buildTransferHookData(SOME_PUBKEY);
    const rawData = buildToken2022Buffer([{ type: 14, data: hookData }]);
    const tokenInfo = {
      isToken2022: true,
      _rawData: rawData,
      hasFreezeAuthority: false,
      hasMintAuthority: false,
      supply: '1000000000',
    };

    client.get.mockResolvedValue({
      data: { outAmount: '9800000' },
    });

    const result = await runAntiScamChecks(config, 'TokenMint', tokenInfo, { outAmount: '50000000' });

    expect(result.riskLevel).toBe('high');
    expect(result.warnings.some((w) => w.includes('Transfer hook'))).toBe(true);
    expect(result.details.transferHook.programId).toBe(SOME_PUBKEY);
  });

  test('skips honeypot check when buyQuote is null', async () => {
    const tokenInfo = {
      isToken2022: false,
      hasFreezeAuthority: false,
      hasMintAuthority: false,
      supply: '1000000000',
    };

    const result = await runAntiScamChecks(config, 'TokenMint', tokenInfo, null);

    expect(result.riskLevel).toBe('low');
    expect(result.details.honeypot).toBeUndefined();
    expect(client.get).not.toHaveBeenCalled();
  });

  test('accumulates multiple Token-2022 warnings', async () => {
    const feeData = buildTransferFeeData({ feeBps: 200 });
    const hookData = buildTransferHookData(SOME_PUBKEY);
    const rawData = buildToken2022Buffer([
      { type: 1, data: feeData },
      { type: 14, data: hookData },
    ]);
    const tokenInfo = {
      isToken2022: true,
      _rawData: rawData,
      hasFreezeAuthority: true,
      hasMintAuthority: true,
      supply: '1000000000',
    };

    client.get.mockResolvedValue({
      data: { outAmount: '9800000' },
    });

    const result = await runAntiScamChecks(config, 'TokenMint', tokenInfo, { outAmount: '50000000' });

    // Transfer fee (200 bps) + transfer hook + freeze authority + mint authority = 4 warnings
    expect(result.warnings.length).toBeGreaterThanOrEqual(4);
    expect(result.riskLevel).toBe('high'); // Transfer hook and freeze authority → high
  });

  test('skips Token-2022 checks for non-Token-2022 tokens', async () => {
    const tokenInfo = {
      isToken2022: false,
      hasFreezeAuthority: false,
      hasMintAuthority: false,
      supply: '1000000000',
    };

    client.get.mockResolvedValue({
      data: { outAmount: '9800000' },
    });

    const result = await runAntiScamChecks(config, 'TokenMint', tokenInfo, { outAmount: '50000000' });

    expect(result.details.transferFee).toBeUndefined();
    expect(result.details.permanentDelegate).toBeUndefined();
    expect(result.details.transferHook).toBeUndefined();
    expect(result.details.nonTransferable).toBeUndefined();
  });

  test('warns on zero supply', async () => {
    const tokenInfo = {
      isToken2022: false,
      hasFreezeAuthority: false,
      hasMintAuthority: false,
      supply: '0',
    };

    client.get.mockResolvedValue({
      data: { outAmount: '9800000' },
    });

    const result = await runAntiScamChecks(config, 'TokenMint', tokenInfo, { outAmount: '50000000' });

    expect(result.warnings.some((w) => w.includes('zero supply'))).toBe(true);
  });
});
