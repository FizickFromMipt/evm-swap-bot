const { ethers } = require('ethers');

/**
 * Check if a string is a valid EVM address (0x-prefixed, 20 bytes hex).
 */
function isValidAddress(addr) {
  return typeof addr === 'string' && ethers.isAddress(addr);
}

module.exports = { isValidAddress };
