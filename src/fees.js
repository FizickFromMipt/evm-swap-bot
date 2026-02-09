const { ethers } = require('ethers');
const logger = require('./logger');

/**
 * Get current gas price from the BSC provider.
 * Compares against maxGasPriceGwei config cap.
 *
 * Returns { gasPrice, gasPriceGwei, capped } or throws if fee data unavailable.
 */
async function getGasPrice(provider, maxGasPriceGwei) {
  logger.step('Fetching gas price...');

  const feeData = await provider.getFeeData();

  if (!feeData.gasPrice) {
    throw new Error('Provider returned no gas price data');
  }

  const gasPrice = feeData.gasPrice;
  const gasPriceGwei = parseFloat(ethers.formatUnits(gasPrice, 'gwei'));

  let capped = false;
  let effectiveGasPrice = gasPrice;

  if (gasPriceGwei > maxGasPriceGwei) {
    logger.warn(`Gas price ${gasPriceGwei.toFixed(2)} gwei exceeds cap (${maxGasPriceGwei} gwei). Using cap.`);
    effectiveGasPrice = ethers.parseUnits(maxGasPriceGwei.toString(), 'gwei');
    capped = true;
  } else {
    logger.info(`Gas price: ${gasPriceGwei.toFixed(2)} gwei`);
  }

  return {
    gasPrice: effectiveGasPrice,
    gasPriceGwei: capped ? maxGasPriceGwei : gasPriceGwei,
    capped,
  };
}

module.exports = { getGasPrice };
