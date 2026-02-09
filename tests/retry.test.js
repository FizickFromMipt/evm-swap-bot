const { withRetry } = require('../src/retry');

describe('withRetry', () => {
  test('returns result on first success', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries on 429 and succeeds', async () => {
    const err = new Error('rate limited');
    err.response = { status: 429 };

    const fn = jest
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue('ok');

    const result = await withRetry(fn, { retries: 2, baseDelay: 10 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('retries on 500 and succeeds', async () => {
    const err = new Error('server error');
    err.response = { status: 500 };

    const fn = jest
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue('ok');

    const result = await withRetry(fn, { retries: 2, baseDelay: 10 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('retries on ECONNRESET', async () => {
    const err = new Error('connection reset');
    err.code = 'ECONNRESET';

    const fn = jest
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue('ok');

    const result = await withRetry(fn, { retries: 2, baseDelay: 10 });
    expect(result).toBe('ok');
  });

  test('does NOT retry on 400 (non-retryable)', async () => {
    const err = new Error('bad request');
    err.response = { status: 400 };

    const fn = jest.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { retries: 3, baseDelay: 10 })).rejects.toThrow('bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('throws after exhausting retries', async () => {
    const err = new Error('server down');
    err.response = { status: 503 };

    const fn = jest.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { retries: 2, baseDelay: 10 })).rejects.toThrow('server down');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  test('calls onRetry callback', async () => {
    const err = new Error('timeout');
    err.response = { status: 502 };

    const fn = jest
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue('ok');

    const onRetry = jest.fn();
    await withRetry(fn, { retries: 2, baseDelay: 10, onRetry });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, 10, err);
  });

  test('returns undefined when retries=0 and fn always throws retryable (BUG-5 regression)', async () => {
    const err = new Error('server error');
    err.response = { status: 500 };
    const fn = jest.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { retries: 0, baseDelay: 10 })).rejects.toThrow('server error');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('applies exponential backoff delay', async () => {
    const err = new Error('down');
    err.response = { status: 500 };

    const fn = jest
      .fn()
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockResolvedValue('ok');

    const onRetry = jest.fn();
    await withRetry(fn, { retries: 3, baseDelay: 100, factor: 2, onRetry });

    // First retry: delay = 100 * 2^0 = 100
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, 100, err);
    // Second retry: delay = 100 * 2^1 = 200
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, 200, err);
  });
});
