import { maskEmail } from './mask-email';

describe('maskEmail', () => {
  it.each([
    ['owner@example.com', 'ow***@example.com'],
    ['first.last@sub.example.co.kr', 'fi***@sub.example.co.kr'],
    ['abc@naver.com', 'ab***@naver.com'],
  ])('%s → %s (first 2 characters + full domain)', (email, masked) => {
    expect(maskEmail(email)).toBe(masked);
  });

  it('keeps one character hidden when the local part is only 2 long', () => {
    expect(maskEmail('ab@x.com')).toBe('a***@x.com');
  });

  it('does not crash on a 1-character local part', () => {
    expect(maskEmail('a@x.com')).toBe('a***@x.com');
  });

  it('always shows *** so the real length is not revealed', () => {
    expect(maskEmail('owner@example.com')).not.toContain('owner');
    expect(maskEmail('averyveryverylongname@example.com')).toBe(
      'av***@example.com',
    );
  });
});
