/**
 * 'owner@example.com' → 'ow***@example.com': the first 2 characters of the
 * local part (always keeping at least one hidden), a fixed '***' so the real
 * length isn't revealed, and the full domain.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = Math.max(1, Math.min(2, local.length - 1));
  return `${local.slice(0, visible)}***@${domain}`;
}
