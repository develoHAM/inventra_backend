/**
 * Emails are case-insensitive, so every email that enters the system is
 * trimmed and lowercased — ' Jane@Acme.COM ' → 'jane@acme.com' — and stored
 * that way: signup, login, password reset, verification and provider emails
 * then always compare equal. As a class-transformer hook, non-strings pass
 * through for the validator to reject.
 */
export function normalizeEmail(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}
