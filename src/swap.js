const { ethers } = require('ethers');
const logger = require('./logger');
const { WBNB } = require('./config');

const ROUTER_ABI = [
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable',
];

const SWAP_DEADLINE_SEC = 300; // 5 minutes

/**
 * Get a quote from PancakeSwap V2 Router via getAmountsOut.
 * Returns the expected output amount as BigInt.
 */
async function getQuote(router, amountInWei, path) {
  const amounts = await router.getAmountsOut(amountInWei, path);
  return amounts[amounts.length - 1];
}

/**
 * Apply slippage to a quote amount.
 * Uses 10000-based precision to support fractional percents (e.g. 5.5%).
 */
function applySlippage(expectedOut, slippagePercent) {
  const bps = BigInt(Math.round(slippagePercent * 100)); // 5% → 500, 5.5% → 550
  return expectedOut * (10000n - bps) / 10000n;
}

/**
 * Execute a buy swap via PancakeSwap V2 Router.
 *
 * Uses swapExactETHForTokensSupportingFeeOnTransferTokens
 * to handle fee-on-transfer / deflationary tokens safely.
 * Retries up to config.buyRetries times with config.buyRetryDelayMs delay.
 *
 * @returns {{ hash: string, amountOutMin: BigInt, expectedOut: BigInt }}
 */
async function executeBuy(wallet, routerAddress, config, tokenAddress, gasSettings) {
  logger.step(`Swapping ${config.buyAmountBnb} BNB for token...`);

  const router = new ethers.Contract(routerAddress, ROUTER_ABI, wallet);
  const path = [WBNB, tokenAddress];
  const amountInWei = config.buyAmountWei;
  const maxAttempts = (config.buyRetries || 0) + 1;
  const retryDelay = config.buyRetryDelayMs || 500;

  // Get quote
  logger.info('Getting quote from PancakeSwap...');
  const expectedOut = await getQuote(router, amountInWei, path);
  logger.info(`  Expected output: ${expectedOut.toString()} (raw)`);

  // Apply slippage (bps-based for fractional precision)
  const amountOutMin = applySlippage(expectedOut, config.slippagePercent);
  logger.info(`  Min output (after ${config.slippagePercent}% slippage): ${amountOutMin.toString()}`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Deadline refreshed each attempt
      const deadline = Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SEC;

      // Build tx
      const txOverrides = {
        value: amountInWei,
        gasLimit: config.gasLimit,
      };

      if (gasSettings?.gasPrice) {
        txOverrides.gasPrice = gasSettings.gasPrice;
      }

      if (attempt > 1) {
        logger.info(`Retry attempt ${attempt}/${maxAttempts}...`);
      }

      logger.info('Sending swap transaction...');
      const tx = await router.swapExactETHForTokensSupportingFeeOnTransferTokens(
        amountOutMin,
        path,
        wallet.address,
        deadline,
        txOverrides
      );

      logger.info(`  TX Hash: ${tx.hash}`);
      logger.info('Waiting for confirmation...');

      const receipt = await tx.wait();

      if (receipt.status === 0) {
        const error = new Error('Transaction reverted on-chain');
        error.txHash = tx.hash;
        throw error;
      }

      logger.success('Swap confirmed!');
      logger.info(`  Block: ${receipt.blockNumber}`);
      logger.info(`  Gas used: ${receipt.gasUsed.toString()}`);

      return { hash: tx.hash, amountOutMin, expectedOut };
    } catch (err) {
      // Don't retry on-chain reverts — they will revert again
      if (err.txHash || attempt === maxAttempts) {
        throw err;
      }
      logger.warn(`Swap attempt ${attempt} failed: ${err.message}. Retrying in ${retryDelay}ms...`);
      await new Promise((r) => setTimeout(r, retryDelay));
    }
  }
}

module.exports = { getQuote, executeBuy, applySlippage, ROUTER_ABI, SWAP_DEADLINE_SEC };
