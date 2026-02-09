const { isValidSolanaMint } = require('../src/validate');

describe('isValidSolanaMint', () => {
  test('accepts valid USDC mint', () => {
    expect(isValidSolanaMint('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(true);
  });

  test('accepts valid SOL mint (System Program)', () => {
    expect(isValidSolanaMint('So11111111111111111111111111111111111111112')).toBe(true);
  });

  test('accepts 32-char base58 address', () => {
    expect(isValidSolanaMint('11111111111111111111111111111111')).toBe(true);
  });

  test('rejects address with invalid char 0', () => {
    expect(isValidSolanaMint('0x1234567890abcdef1234567890abcdef12345678')).toBe(false);
  });

  test('rejects address with invalid char O (uppercase O)', () => {
    expect(isValidSolanaMint('OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO')).toBe(false);
  });

  test('rejects address with invalid char l (lowercase L)', () => {
    expect(isValidSolanaMint('llllllllllllllllllllllllllllllllll')).toBe(false);
  });

  test('rejects too short string', () => {
    expect(isValidSolanaMint('abc123')).toBe(false);
  });

  test('rejects too long string (45 chars)', () => {
    expect(isValidSolanaMint('A'.repeat(45))).toBe(false);
  });

  test('rejects empty string', () => {
    expect(isValidSolanaMint('')).toBe(false);
  });

  test('rejects non-string inputs', () => {
    expect(isValidSolanaMint(null)).toBe(false);
    expect(isValidSolanaMint(undefined)).toBe(false);
    expect(isValidSolanaMint(123)).toBe(false);
  });
});
