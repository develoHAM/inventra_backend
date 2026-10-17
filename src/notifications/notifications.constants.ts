export const NOTIFICATIONS_QUEUE = 'notifications';
export const SEND_NOTIFICATION_JOB = 'send';
export interface SendNotificationJobData {
  notificationId: string;
  /** Present only for redacted notifications: the real text, which the row doesn't keep. */
  body?: string;
}

// BullMQ runs jobs WITHOUT a priority before any prioritized job, so regular
// notifications take priority 10 and leave the front of the line to secret,
// time-sensitive messages (verification codes).
export const SEND_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: true,
  priority: 10,
};

// A code is useless if it arrives late, and its text must not linger in Redis
// after the job ends, whichever way it ends.
export const REDACTED_SEND_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'fixed', delay: 2000 },
  removeOnComplete: true,
  removeOnFail: true,
};

/** Injection token for "whichever push sender this environment uses". */
export const PUSH_SENDER = 'PUSH_SENDER';
