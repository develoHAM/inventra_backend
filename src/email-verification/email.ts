/**
 * class-transformer hook and service helper: ' New@Example.com ' →
 * 'new@example.com', so the verified address and the address used at signup
 * always compare equal. Non-strings pass through for the validator to reject.
 */
export function normalizeEmail(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}
