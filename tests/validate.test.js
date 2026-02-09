const { isValidAddress } = require('../src/validate');

describe('isValidAddress', () => {
  test('valid checksummed address', () => {
    expect(isValidAddress('0x10ED43C718714eb63d5aA57B78B54704E256024E')).toBe(true);
  });

  test('valid lowercase address', () => {
    expect(isValidAddress('0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c')).toBe(true);
  });

  test('valid WBNB address', () => {
    expect(isValidAddress('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c')).toBe(true);
  });

  test('zero address is valid', () => {
    expect(isValidAddress('0x0000000000000000000000000000000000000000')).toBe(true);
  });

  test('rejects non-string', () => {
    expect(isValidAddress(123)).toBe(false);
    expect(isValidAddress(null)).toBe(false);
    expect(isValidAddress(undefined)).toBe(false);
  });

  test('rejects empty string', () => {
    expect(isValidAddress('')).toBe(false);
  });

  test('accepts address without 0x prefix (ethers normalizes it)', () => {
    // ethers.isAddress accepts raw hex without 0x prefix
    expect(isValidAddress('10ED43C718714eb63d5aA57B78B54704E256024E')).toBe(true);
  });

  test('rejects too short address', () => {
    expect(isValidAddress('0x1234')).toBe(false);
  });

  test('rejects too long address', () => {
    expect(isValidAddress('0x10ED43C718714eb63d5aA57B78B54704E256024EFF')).toBe(false);
  });

  test('rejects non-hex characters', () => {
    expect(isValidAddress('0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG')).toBe(false);
  });
});
