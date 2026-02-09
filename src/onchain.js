const { PublicKey } = require('@solana/web3.js');
const logger = require('./logger');

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/**
 * Parse raw SPL Mint account data (82 bytes).
 *
 * Layout:
 *   [0..4)    mintAuthorityOption  (u32 LE)
 *   [4..36)   mintAuthority        (Pubkey)
 *   [36..44)  supply               (u64 LE)
 *   [44]      decimals             (u8)
 *   [45]      isInitialized        (bool)
 *   [46..50)  freezeAuthorityOption (u32 LE)
 *   [50..82)  freezeAuthority      (Pubkey)
 */
function parseMintData(data) {
  if (!data || data.length < 82) return null;

  const hasMintAuthority = data.readUInt32LE(0) !== 0;
  const mintAuthority = hasMintAuthority
    ? new PublicKey(data.slice(4, 36)).toBase58()
    : null;

  const supply = data.readBigUInt64LE(36);
  const decimals = data[44];
  const isInitialized = data[45] !== 0;

  const hasFreezeAuthority = data.readUInt32LE(46) !== 0;
  const freezeAuthority = hasFreezeAuthority
    ? new PublicKey(data.slice(50, 82)).toBase58()
    : null;

  return {
    supply: supply.toString(),
    decimals,
    isInitialized,
    hasMintAuthority,
    mintAuthority,
    hasFreezeAuthority,
    freezeAuthority,
  };
}

/**
 * Validate a token mint on-chain.
 * Checks: account exists, is SPL token, is initialized.
 * Returns warnings about rug risk factors.
 */
async function validateTokenMint(connection, mintAddress) {
  logger.step('Validating token mint on-chain...');

  let pubkey;
  try {
    pubkey = new PublicKey(mintAddress);
  } catch {
    return { valid: false, reason: 'Invalid public key format' };
  }

  const accountInfo = await connection.getAccountInfo(pubkey);

  if (!accountInfo) {
    return { valid: false, reason: 'Token mint account does not exist on-chain' };
  }

  // Must be owned by Token Program or Token-2022
  const owner = accountInfo.owner.toBase58();
  if (owner !== TOKEN_PROGRAM_ID && owner !== TOKEN_2022_PROGRAM_ID) {
    return { valid: false, reason: `Account is not an SPL token mint (owner: ${owner})` };
  }

  const mint = parseMintData(accountInfo.data);
  if (!mint) {
    return { valid: false, reason: 'Invalid mint account data (too short)' };
  }

  if (!mint.isInitialized) {
    return { valid: false, reason: 'Token mint is not initialized' };
  }

  // Collect warnings
  const warnings = [];

  if (mint.supply === '0') {
    warnings.push('Token has zero supply');
  }

  if (mint.hasFreezeAuthority) {
    warnings.push(
      `Freeze authority is set (${mint.freezeAuthority}) — token accounts can be frozen (rug risk)`
    );
  }

  if (mint.hasMintAuthority) {
    warnings.push(
      `Mint authority is set (${mint.mintAuthority}) — unlimited tokens can be minted (inflation risk)`
    );
  }

  // Log results
  logger.info(`  Token program: ${owner === TOKEN_2022_PROGRAM_ID ? 'Token-2022' : 'SPL Token'}`);
  logger.info(`  Supply: ${mint.supply} (${mint.decimals} decimals)`);
  logger.info(`  Mint authority: ${mint.mintAuthority || 'revoked'}`);
  logger.info(`  Freeze authority: ${mint.freezeAuthority || 'revoked'}`);

  if (warnings.length > 0) {
    logger.sep();
    logger.warn('On-chain risk warnings:');
    warnings.forEach((w) => logger.warn(`  - ${w}`));
  } else {
    logger.success('No on-chain risk flags detected');
  }

  return {
    valid: true,
    supply: mint.supply,
    decimals: mint.decimals,
    hasMintAuthority: mint.hasMintAuthority,
    mintAuthority: mint.mintAuthority,
    hasFreezeAuthority: mint.hasFreezeAuthority,
    freezeAuthority: mint.freezeAuthority,
    isToken2022: owner === TOKEN_2022_PROGRAM_ID,
    warnings,
    _rawData: accountInfo.data, // raw Buffer for Token-2022 extension parsing
  };
}

/**
 * Check that a pool account exists on-chain.
 * Returns { exists, owner, dataSize } or { exists: false }.
 */
async function validatePoolAccount(connection, poolAddress) {
  let pubkey;
  try {
    pubkey = new PublicKey(poolAddress);
  } catch {
    return { exists: false, reason: 'Invalid pool address' };
  }

  const accountInfo = await connection.getAccountInfo(pubkey);

  if (!accountInfo) {
    return { exists: false, reason: 'Pool account does not exist on-chain' };
  }

  return {
    exists: true,
    owner: accountInfo.owner.toBase58(),
    dataSize: accountInfo.data.length,
    lamports: accountInfo.lamports,
  };
}

module.exports = { validateTokenMint, validatePoolAccount, parseMintData };
