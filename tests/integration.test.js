/**
 * Integration tests — verify parseArgs and EXIT codes.
 * Full flow integration is harder to test with EVM mocking, so we focus on
 * the CLI parsing layer and config validation end-to-end.
 */

const { parseArgs, EXIT } = require('../src/index');

describe('parseArgs', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  test('parses positional token address', () => {
    process.argv = ['node', 'index.js', '0x1234567890abcdef1234567890abcdef12345678'];
    const result = parseArgs();
    expect(result.tokenAddress).toBe('0x1234567890abcdef1234567890abcdef12345678');
  });

  test('parses --dry-run flag', () => {
    process.argv = ['node', 'index.js', '0xABCD', '--dry-run'];
    const result = parseArgs();
    expect(result.isDryRun).toBe(true);
  });

  test('parses --yes flag', () => {
    process.argv = ['node', 'index.js', '0xABCD', '--yes'];
    const result = parseArgs();
    expect(result.skipConfirm).toBe(true);
  });

  test('parses -y flag', () => {
    process.argv = ['node', 'index.js', '0xABCD', '-y'];
    const result = parseArgs();
    expect(result.skipConfirm).toBe(true);
  });

  test('parses --amount flag', () => {
    process.argv = ['node', 'index.js', '0xABCD', '--amount', '0.05'];
    const result = parseArgs();
    expect(result.cliAmount).toBe('0.05');
  });

  test('parses --continuous flag', () => {
    process.argv = ['node', 'index.js', '--continuous'];
    const result = parseArgs();
    expect(result.continuous).toBe(true);
  });

  test('parses --token named argument', () => {
    process.argv = ['node', 'index.js', '--token', '0xABCD'];
    const result = parseArgs();
    expect(result.tokenAddress).toBe('0xABCD');
  });

  test('returns null for missing optional args', () => {
    process.argv = ['node', 'index.js', '0xABCD'];
    const result = parseArgs();
    expect(result.cliAmount).toBeNull();
    expect(result.isDryRun).toBe(false);
    expect(result.skipConfirm).toBe(false);
    expect(result.continuous).toBe(false);
  });
});

describe('EXIT codes', () => {
  test('all exit codes are unique', () => {
    const values = Object.values(EXIT);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  test('EXIT.SUCCESS is 0', () => {
    expect(EXIT.SUCCESS).toBe(0);
  });

  test('all expected codes exist', () => {
    expect(EXIT.BAD_ARGS).toBeDefined();
    expect(EXIT.CONFIG_ERROR).toBeDefined();
    expect(EXIT.RPC_ERROR).toBeDefined();
    expect(EXIT.INSUFFICIENT_FUNDS).toBeDefined();
    expect(EXIT.SWAP_ERROR).toBeDefined();
    expect(EXIT.TOKEN_INVALID).toBeDefined();
    expect(EXIT.SCAM_DETECTED).toBeDefined();
  });
});
