const { ethers } = require('ethers');
const logger = require('./logger');

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function owner() view returns (address)',
];

/**
 * Get token info from an ERC20 contract on-chain.
 * Returns { name, symbol, decimals, totalSupply, owner } or throws.
 */
async function getTokenInfo(provider, tokenAddress) {
  logger.step('Fetching token info on-chain...');

  const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

  const [name, symbol, decimals, totalSupply] = await Promise.all([
    contract.name().catch(() => 'Unknown'),
    contract.symbol().catch(() => '???'),
    contract.decimals().catch(() => 18),
    contract.totalSupply().catch(() => 0n),
  ]);

  let owner = null;
  try {
    owner = await contract.owner();
  } catch {
    // owner() not implemented — no Ownable
  }

  logger.info(`  Name: ${name}`);
  logger.info(`  Symbol: ${symbol}`);
  logger.info(`  Decimals: ${decimals}`);
  logger.info(`  Total supply: ${ethers.formatUnits(totalSupply, decimals)}`);
  logger.info(`  Owner: ${owner || 'N/A (no Ownable)'}`);

  return { name, symbol, decimals, totalSupply, owner };
}

module.exports = { getTokenInfo, ERC20_ABI };
