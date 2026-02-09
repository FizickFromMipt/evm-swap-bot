const RETRYABLE_CODES = ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN'];

/**
 * Retry an async function with exponential backoff.
 * Only retries on transient HTTP errors (429, 5xx) and network errors.
 */
async function withRetry(fn, opts = {}) {
  const { retries = 3, baseDelay = 1000, factor = 2, onRetry } = opts;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      const isRetryable =
        status === 429 ||
        (status >= 500 && status < 600) ||
        RETRYABLE_CODES.includes(err.code);

      if (!isRetryable || attempt === retries) throw err;

      const delay = baseDelay * Math.pow(factor, attempt);
      if (onRetry) onRetry(attempt + 1, delay, err);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

module.exports = { withRetry };
