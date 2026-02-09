const { PublicKey } = require('@solana/web3.js');
const { client } = require('./http');
const { withRetry } = require('./retry');
const logger = require('./logger');

// Token-2022 extension type IDs
const EXT_TRANSFER_FEE_CONFIG = 1;
const EXT_NON_TRANSFERABLE = 9;
const EXT_PERMANENT_DELEGATE = 12;
const EXT_TRANSFER_HOOK = 14;

/**
 * Parse Token-2022 TLV extensions from raw mint account data.
 * Extensions start at byte 83 (after 82-byte mint data + 1 byte account type).
 */
function parseToken2022Extensions(data) {
  if (!data || data.length <= 83) return [];

  // Byte 82 must be account type 2 (Mint)
  if (data[82] !== 2) return [];

  const extensions = [];
  let offset = 83;

  while (offset + 4 <= data.length) {
    const type = data.readUInt16LE(offset);
    const length = data.readUInt16LE(offset + 2);
    offset += 4;

    if (offset + length > data.length) break;

    extensions.push({ type, data: data.slice(offset, offset + length) });
    offset += length;
  }

  return extensions;
}

/**
 * Check for TransferFeeConfig extension (type 1).
 *
 * Layout (108 bytes):
 *   [0..32)   transferFeeConfigAuthority  (Pubkey)
 *   [32..64)  withdrawWithheldAuthority   (Pubkey)
 *   [64..72)  withheldAmount              (u64 LE)
 *   [72..90)  olderTransferFee            (TransferFee)
 *   [90..108) newerTransferFee            (TransferFee)
 *
 * TransferFee (18 bytes): epoch(u64) + maxFee(u64) + bps(u16)
 */
function checkTransferFee(extensions) {
  const ext = extensions.find((e) => e.type === EXT_TRANSFER_FEE_CONFIG);
  if (!ext || ext.data.length < 108) return null;

  // newerTransferFee.transfer_fee_basis_points at offset 106
  const feeBps = ext.data.readUInt16LE(106);
  const maxFee = ext.data.readBigUInt64LE(98);

  return { hasTransferFee: feeBps > 0, feeBps, maxFee: maxFee.toString() };
}

/**
 * Check for PermanentDelegate extension (type 12).
 * A permanent delegate can transfer or burn anyone's tokens.
 */
function checkPermanentDelegate(extensions) {
  const ext = extensions.find((e) => e.type === EXT_PERMANENT_DELEGATE);
  if (!ext || ext.data.length < 32) return null;

  const delegate = new PublicKey(ext.data.slice(0, 32));
  if (delegate.equals(PublicKey.default)) return null;

  return { hasPermanentDelegate: true, delegate: delegate.toBase58() };
}

/**
 * Check for NonTransferable extension (type 9).
 * Token literally cannot be transferred — soulbound.
 */
function checkNonTransferable(extensions) {
  return extensions.some((e) => e.type === EXT_NON_TRANSFERABLE);
}

/**
 * Check for TransferHook extension (type 14).
 * Custom on-chain program executes on every transfer — can reject arbitrarily.
 */
function checkTransferHook(extensions) {
  const ext = extensions.find((e) => e.type === EXT_TRANSFER_HOOK);
  if (!ext || ext.data.length < 32) return null;

  const programId = new PublicKey(ext.data.slice(0, 32));
  if (programId.equals(PublicKey.default)) return null;

  return { hasTransferHook: true, programId: programId.toBase58() };
}

/**
 * Simulate a reverse swap (TOKEN → SOL) via Jupiter quote to detect honeypots.
 * If Jupiter can't route the sell, the token may be unsellable.
 */
async function checkHoneypot(config, tokenMint, buyQuote) {
  logger.info('Simulating reverse swap (sell) to detect honeypot...');

  try {
    const sellAmount = buyQuote.outAmount;

    const { data } = await withRetry(
      () =>
        client.get(config.jupiterApi.quote, {
          params: {
            inputMint: tokenMint,
            outputMint: config.solMint,
            amount: sellAmount,
            slippageBps: config.slippageBps,
          },
          timeout: 15000,
        }),
      { retries: 2, baseDelay: 1000 }
    );

    if (!data || !data.outAmount) {
      return {
        canSell: false,
        reason: 'No sell route found — token may be a honeypot',
      };
    }

    // Round-trip loss: how much SOL we lose buying then immediately selling
    const buyInLamports = BigInt(config.amountLamports);
    const sellOutLamports = BigInt(data.outAmount);
    const roundTripLossPct =
      buyInLamports > 0n
        ? Number((buyInLamports - sellOutLamports) * 10000n / buyInLamports) / 100
        : 0;

    const result = {
      canSell: true,
      sellOutAmount: data.outAmount,
      sellPriceImpact: data.priceImpactPct || 'N/A',
      roundTripLossPct,
    };

    if (roundTripLossPct > 50) {
      result.warning = `Extreme round-trip loss: ${roundTripLossPct.toFixed(1)}% — likely honeypot or extreme tax`;
    } else if (roundTripLossPct > 20) {
      result.warning = `High round-trip loss: ${roundTripLossPct.toFixed(1)}% — possible hidden sell tax`;
    }

    return result;
  } catch (err) {
    return {
      canSell: false,
      reason: `Sell simulation failed: ${err.message}`,
    };
  }
}

/**
 * Run all anti-scam checks and return a risk assessment.
 *
 * @param {object} config       - Bot config (Jupiter API URLs, etc.)
 * @param {string} tokenMint    - Token mint address
 * @param {object} tokenInfo    - Result from validateTokenMint (includes _rawData)
 * @param {object} buyQuote     - Jupiter buy quote (for honeypot simulation)
 * @returns {{ riskLevel: string, warnings: string[], details: object }}
 */
async function runAntiScamChecks(config, tokenMint, tokenInfo, buyQuote) {
  logger.step('Running anti-scam checks...');

  const warnings = [];
  const details = {};

  // --- Token-2022 extension checks ---
  if (tokenInfo.isToken2022 && tokenInfo._rawData) {
    const extensions = parseToken2022Extensions(tokenInfo._rawData);

    const feeInfo = checkTransferFee(extensions);
    if (feeInfo && feeInfo.hasTransferFee) {
      details.transferFee = feeInfo;
      warnings.push(
        `Transfer fee: ${feeInfo.feeBps} bps (${(feeInfo.feeBps / 100).toFixed(2)}%) on every transfer`
      );
      if (feeInfo.feeBps >= 1000) {
        warnings.push(`EXTREME transfer fee (${(feeInfo.feeBps / 100).toFixed(0)}%) — likely a scam`);
      }
    }

    const delegateInfo = checkPermanentDelegate(extensions);
    if (delegateInfo) {
      details.permanentDelegate = delegateInfo;
      warnings.push(
        `Permanent delegate (${delegateInfo.delegate}) — can transfer/burn your tokens at any time`
      );
    }

    if (checkNonTransferable(extensions)) {
      details.nonTransferable = true;
      warnings.push('Token is NON-TRANSFERABLE — you will not be able to sell or transfer it');
    }

    const hookInfo = checkTransferHook(extensions);
    if (hookInfo) {
      details.transferHook = hookInfo;
      warnings.push(
        `Transfer hook program (${hookInfo.programId}) — custom logic on every transfer, can reject sells`
      );
    }
  }

  // --- On-chain authority warnings ---
  if (tokenInfo.hasFreezeAuthority) {
    warnings.push('Freeze authority active — your tokens can be frozen (blacklist risk)');
  }
  if (tokenInfo.hasMintAuthority) {
    warnings.push('Mint authority active — unlimited token inflation possible');
  }
  if (tokenInfo.supply === '0') {
    warnings.push('Token has zero supply — suspicious');
  }

  // --- Honeypot simulation ---
  if (buyQuote) {
    const honeypot = await checkHoneypot(config, tokenMint, buyQuote);
    details.honeypot = honeypot;

    if (!honeypot.canSell) {
      warnings.push(`HONEYPOT RISK: ${honeypot.reason}`);
    } else if (honeypot.warning) {
      warnings.push(honeypot.warning);
    } else {
      logger.info(
        `  Sell simulation OK: round-trip loss ${honeypot.roundTripLossPct.toFixed(1)}%`
      );
    }
  }

  // --- Determine risk level ---
  const hasCritical = warnings.some(
    (w) =>
      w.includes('HONEYPOT') ||
      w.includes('EXTREME') ||
      w.includes('Permanent delegate') ||
      w.includes('NON-TRANSFERABLE')
  );
  const hasHigh = warnings.some(
    (w) =>
      w.includes('Freeze authority') ||
      w.includes('Transfer hook') ||
      w.includes('High round-trip')
  );

  let riskLevel = 'low';
  if (hasCritical) riskLevel = 'critical';
  else if (hasHigh) riskLevel = 'high';
  else if (warnings.length > 0) riskLevel = 'medium';

  // --- Log ---
  if (warnings.length === 0) {
    logger.success('Anti-scam: no scam indicators detected');
  } else {
    const label = riskLevel.toUpperCase();
    logger.warn(`Anti-scam risk level: ${label} (${warnings.length} warning(s))`);
    warnings.forEach((w) => logger.warn(`  - ${w}`));
  }

  return { riskLevel, warnings, details };
}

module.exports = {
  runAntiScamChecks,
  checkHoneypot,
  parseToken2022Extensions,
  checkTransferFee,
  checkPermanentDelegate,
  checkNonTransferable,
  checkTransferHook,
};
