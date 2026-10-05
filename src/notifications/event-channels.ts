import { NotificationChannel } from '../generated/prisma/enums';
import { NotificationEvent } from './notification-events';

/** Any one event name: 'company.approved' | 'order.created' | … */
export type NotificationEventName =
  (typeof NotificationEvent)[keyof typeof NotificationEvent];

const EMAIL_AND_PUSH = [NotificationChannel.EMAIL, NotificationChannel.PUSH];

/**
 * Which channels each event uses. Record<…> makes the table exhaustive:
 * a new event that isn't listed here is a compile error.
 * Every event is email + push (decision 2026-09-27).
 */
export const EVENT_CHANNELS: Record<
  NotificationEventName,
  NotificationChannel[]
> = {
  [NotificationEvent.COMPANY_APPROVED]: EMAIL_AND_PUSH,
  [NotificationEvent.COMPANY_REGISTERED]: EMAIL_AND_PUSH,
  [NotificationEvent.MEMBER_JOIN_REQUESTED]: EMAIL_AND_PUSH,
  [NotificationEvent.MEMBER_APPROVED]: EMAIL_AND_PUSH,
  [NotificationEvent.ORDER_CREATED]: EMAIL_AND_PUSH,
  [NotificationEvent.AUDIT_APPLIED]: EMAIL_AND_PUSH,
  [NotificationEvent.STOCK_BELOW_TARGET]: EMAIL_AND_PUSH,
  [NotificationEvent.ACCOUNT_PASSWORD_RESET]: EMAIL_AND_PUSH,
};
