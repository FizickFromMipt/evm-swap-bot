/**
 * Check if a string is a valid Solana base58 mint address (32-44 chars, base58 alphabet).
 */
function isValidSolanaMint(addr) {
  return typeof addr === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}

module.exports = { isValidSolanaMint };
