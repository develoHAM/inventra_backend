/** Korean mobile, digits only. 010 + 8 digits — the only format OCTOMO accepts. */
export const KOREAN_MOBILE_PATTERN = /^010\d{8}$/;

/**
 * class-transformer hook: "010-1234-5678" → "01012345678".
 * Non-strings pass through untouched so the validator can reject them with a 400.
 */
export function normalizePhone(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(/[-\s]/g, '') : value;
}
