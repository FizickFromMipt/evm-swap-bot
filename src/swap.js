const logger = require('./logger');
const { client } = require('./http');
const { withRetry } = require('./retry');

const ZEROX_HEADERS = (apiKey) => ({
  '0x-api-key': apiKey,
  '0x-version': 'v2',
});

/**
 * Get a price quote from 0x API (no calldata, just pricing info).
 * Used for estimations and honeypot simulation.
 */
async function getQuote(config, sellToken, buyToken, sellAmount, taker) {
  const { data } = await client.get(`${config.zeroxApiUrl}/swap/allowance-holder/price`, {
    headers: ZEROX_HEADERS(config.routerZeroxApiKey),
    params: {
      chainId: 56,
      sellToken,
      buyToken,
      sellAmount: sellAmount.toString(),
      taker,
    },
  });
  return data;
}

/**
 * Format route fills for logging.
 * Example: "PancakeSwap_V2 (60%) + DODO (40%)"
 */
function formatRoute(route) {
  if (!route?.fills?.length) return 'unknown';
  return route.fills
    .map((f) => `${f.source} (${(parseFloat(f.proportionBps) / 100).toFixed(0)}%)`)
    .join(' + ');
}

/**
 * Execute a buy swap via 0x Swap API v2.
 *
 * 1. GET /swap/allowance-holder/quote with retry
 * 2. Check liquidityAvailable
 * 3. wallet.sendTransaction({ to, data, value, gasLimit })
 * 4. tx.wait() → check receipt.status
 *
 * @returns {{ hash: string, buyAmount: string, minBuyAmount: string, route: object }}
 */
async function executeBuy(wallet, config, tokenAddress, gasSettings) {
  logger.step(`Swapping ${config.buyAmountBnb} BNB for token via 0x...`);

  const sellAmount = config.buyAmountWei;

  // 1. Get quote with calldata from 0x
  logger.info('Getting quote from 0x aggregator...');
  const quote = await withRetry(
    () =>
      client.get(`${config.zeroxApiUrl}/swap/allowance-holder/quote`, {
        headers: ZEROX_HEADERS(config.routerZeroxApiKey),
        params: {
          chainId: 56,
          sellToken: config.nativeToken,
          buyToken: tokenAddress,
          sellAmount: sellAmount.toString(),
          taker: wallet.address,
          slippageBps: config.slippageBps,
        },
      }),
    {
      retries: config.buyRetries || 3,
      baseDelay: config.buyRetryDelayMs || 500,
      onRetry: (attempt, delay, err) => {
        logger.warn(`Quote attempt ${attempt} failed: ${err.message}. Retrying in ${delay}ms...`);
      },
    }
  ).then((res) => res.data);

  // 2. Check liquidity
  if (quote.liquidityAvailable === false) {
    throw new Error('No liquidity available for this token on any DEX');
  }

  logger.info(`  Buy amount: ${quote.buyAmount} (raw)`);
  logger.info(`  Min buy amount: ${quote.minBuyAmount}`);
  logger.info(`  Route: ${formatRoute(quote.route)}`);

  // Check sell tax from token metadata
  const sellTaxBps = quote.tokenMetadata?.buyToken?.sellTaxBps;
  if (sellTaxBps && parseInt(sellTaxBps) > 0) {
    logger.warn(`  Token has sell tax: ${(parseInt(sellTaxBps) / 100).toFixed(1)}%`);
  }

  // 3. Send transaction
  logger.info('Sending swap transaction...');
  const txRequest = {
    to: quote.transaction.to,
    data: quote.transaction.data,
    value: BigInt(quote.transaction.value),
    gasLimit: quote.transaction.gas ? parseInt(quote.transaction.gas) : config.gasLimit,
  };

  if (gasSettings?.gasPrice) {
    txRequest.gasPrice = gasSettings.gasPrice;
  }

  const tx = await wallet.sendTransaction(txRequest);
  logger.info(`  TX Hash: ${tx.hash}`);
  logger.info('Waiting for confirmation...');

  // 4. Wait for confirmation
  const receipt = await tx.wait();

  if (receipt.status === 0) {
    const error = new Error('Transaction reverted on-chain');
    error.txHash = tx.hash;
    throw error;
  }

  logger.success('Swap confirmed!');
  logger.info(`  Block: ${receipt.blockNumber}`);
  logger.info(`  Gas used: ${receipt.gasUsed.toString()}`);

  return {
    hash: tx.hash,
    buyAmount: quote.buyAmount,
    minBuyAmount: quote.minBuyAmount,
    route: quote.route,
  };
}

module.exports = { getQuote, executeBuy, formatRoute, ZEROX_HEADERS };
