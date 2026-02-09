const { ethers } = require('ethers');
const logger = require('./logger');
const { WBNB } = require('./config');
const { ROUTER_ABI } = require('./swap');

// EIP-1967 implementation slot
const EIP1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

/**
 * Honeypot detection via roundtrip simulation.
 * Simulates buy + sell quotes via PancakeSwap getAmountsOut.
 * If sell returns significantly less BNB than buy cost, it's suspicious.
 */
async function checkHoneypot(provider, routerAddress, tokenAddress, amountInWei) {
  logger.info('Simulating roundtrip swap to detect honeypot...');

  try {
    const router = new ethers.Contract(routerAddress, ROUTER_ABI, provider);

    // Buy quote: BNB → Token
    const buyPath = [WBNB, tokenAddress];
    const buyAmounts = await router.getAmountsOut(amountInWei, buyPath);
    const tokenReceived = buyAmounts[buyAmounts.length - 1];

    if (tokenReceived === 0n) {
      return { canSell: false, reason: 'Buy quote returned 0 tokens' };
    }

    // Sell quote: Token → BNB
    const sellPath = [tokenAddress, WBNB];
    let sellAmounts;
    try {
      sellAmounts = await router.getAmountsOut(tokenReceived, sellPath);
    } catch {
      return { canSell: false, reason: 'Sell quote failed — token may be a honeypot' };
    }

    const bnbReturned = sellAmounts[sellAmounts.length - 1];

    // Round-trip loss
    const roundTripLossPct =
      amountInWei > 0n
        ? Number((amountInWei - bnbReturned) * 10000n / amountInWei) / 100
        : 0;

    const result = {
      canSell: true,
      tokenReceived: tokenReceived.toString(),
      bnbReturned: bnbReturned.toString(),
      roundTripLossPct,
    };

    if (roundTripLossPct > 50) {
      result.warning = `Extreme round-trip loss: ${roundTripLossPct.toFixed(1)}% — likely honeypot or extreme tax`;
    } else if (roundTripLossPct > 20) {
      result.warning = `High round-trip loss: ${roundTripLossPct.toFixed(1)}% — possible hidden sell tax`;
    }

    return result;
  } catch (err) {
    return { canSell: false, reason: `Honeypot simulation failed: ${err.message}` };
  }
}

/**
 * Check if contract is an EIP-1967 proxy (upgradeable).
 * Reads the implementation storage slot.
 */
async function checkProxy(provider, tokenAddress) {
  try {
    const implSlot = await provider.getStorage(tokenAddress, EIP1967_IMPL_SLOT);
    const implAddress = '0x' + implSlot.slice(26); // last 20 bytes

    if (implAddress !== '0x' + '0'.repeat(40)) {
      return { isProxy: true, implementation: ethers.getAddress(implAddress) };
    }
    return { isProxy: false };
  } catch {
    return { isProxy: false };
  }
}

/**
 * Check if ownership is renounced by calling owner().
 * If owner is not address(0), ownership is NOT renounced.
 */
async function checkOwnership(provider, tokenAddress) {
  try {
    const contract = new ethers.Contract(
      tokenAddress,
      ['function owner() view returns (address)'],
      provider
    );
    const owner = await contract.owner();
    const renounced = owner === ethers.ZeroAddress;
    return { hasOwner: !renounced, owner, renounced };
  } catch {
    // owner() not available — assume no owner
    return { hasOwner: false, owner: null, renounced: true };
  }
}

/**
 * Run all anti-scam checks and return a risk assessment.
 *
 * @returns {{ riskLevel: string, warnings: string[], details: object }}
 */
async function runAntiScamChecks(provider, routerAddress, tokenAddress, amountInWei, tokenInfo) {
  logger.step('Running anti-scam checks...');

  const warnings = [];
  const details = {};

  // --- Honeypot simulation ---
  const honeypot = await checkHoneypot(provider, routerAddress, tokenAddress, amountInWei);
  details.honeypot = honeypot;

  if (!honeypot.canSell) {
    warnings.push(`HONEYPOT RISK: ${honeypot.reason}`);
  } else if (honeypot.warning) {
    warnings.push(honeypot.warning);
  } else {
    logger.info(`  Sell simulation OK: round-trip loss ${honeypot.roundTripLossPct.toFixed(1)}%`);
  }

  // --- Proxy detection ---
  const proxy = await checkProxy(provider, tokenAddress);
  details.proxy = proxy;

  if (proxy.isProxy) {
    warnings.push(`Contract is an upgradeable proxy (impl: ${proxy.implementation}) — owner can change logic`);
  }

  // --- Ownership check ---
  const ownership = await checkOwnership(provider, tokenAddress);
  details.ownership = ownership;

  if (ownership.hasOwner) {
    warnings.push(`Ownership NOT renounced (owner: ${ownership.owner}) — owner may have special privileges`);
  }

  // --- Token info warnings ---
  if (tokenInfo) {
    if (tokenInfo.totalSupply === 0n) {
      warnings.push('Token has zero supply — suspicious');
    }
  }

  // --- Determine risk level ---
  const hasCritical = warnings.some(
    (w) => w.includes('HONEYPOT') || w.includes('Extreme round-trip')
  );
  const hasHigh = warnings.some(
    (w) => w.includes('High round-trip') || w.includes('upgradeable proxy')
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
  checkProxy,
  checkOwnership,
  EIP1967_IMPL_SLOT,
};
