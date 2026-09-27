import { KOREAN_MOBILE_PATTERN, normalizePhone } from './phone';

describe('normalizePhone', () => {
  it('strips dashes and spaces', () => {
    expect(normalizePhone('010-1234-5678')).toBe('01012345678');
    expect(normalizePhone(' 010 1234 5678 ')).toBe('01012345678');
    expect(normalizePhone('01012345678')).toBe('01012345678');
  });

  it('passes non-strings through untouched (the validator rejects them)', () => {
    expect(normalizePhone(12345)).toBe(12345);
    expect(normalizePhone(undefined)).toBeUndefined();
    expect(normalizePhone(null)).toBeNull();
  });
});

describe('KOREAN_MOBILE_PATTERN (the format OCTOMO accepts)', () => {
  it('accepts 010 + 8 digits', () => {
    expect(KOREAN_MOBILE_PATTERN.test('01012345678')).toBe(true);
  });

  it.each([
    ['a Seoul landline', '0212345678'],
    ['an un-normalized number', '010-1234-5678'],
    ['too many digits', '010123456789'],
    ['too few digits', '0101234567'],
    ['the +82 international form', '+821012345678'],
    ['a legacy 011 number', '0111234567'],
    ['a legacy 016 number', '01612345678'],
    ['a legacy 019 number', '01912345678'],
    ['an empty string', ''],
  ])('rejects %s', (_description, phone) => {
    expect(KOREAN_MOBILE_PATTERN.test(phone)).toBe(false);
  });
});
