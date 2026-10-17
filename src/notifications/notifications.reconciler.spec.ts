import { Logger } from '@nestjs/common';
import { NotificationsReconciler } from './notifications.reconciler';
import { NotificationStatus } from '../generated/prisma/enums';
import {
  SEND_JOB_OPTIONS,
  SEND_NOTIFICATION_JOB,
} from './notifications.constants';

describe('NotificationsReconciler', () => {
  let reconciler: NotificationsReconciler;
  let prisma: { notification: { findMany: jest.Mock; updateMany: jest.Mock } };
  let queue: { add: jest.Mock };

  // Freeze "now" so the 10-minute cutoff is an exact, assertable Date.
  const now = new Date('2026-09-27T10:05:00.000Z');
  const tenMinutesAgo = new Date('2026-09-27T09:55:00.000Z');

  beforeEach(() => {
    jest.useFakeTimers({ now: now });
    prisma = {
      notification: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    queue = { add: jest.fn().mockResolvedValue({ id: 'job' }) };
    reconciler = new NotificationsReconciler(prisma as any, queue as any);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('looks only for PENDING rows created more than 10 minutes ago, 100 at a time', async () => {
    await reconciler.requeueStalePending();

    expect(prisma.notification.findMany).toHaveBeenCalledWith({
      where: {
        status: NotificationStatus.PENDING,
        redacted: false, // a redacted row can't be rebuilt from its placeholder
        createdAt: { lt: tenMinutesAgo },
      },
      select: { id: true },
      take: 100,
    });
  });

  it('re-enqueues each stale row with jobId = its id (so a still-queued job is not duplicated)', async () => {
    prisma.notification.findMany.mockResolvedValue([
      { id: 'n-1' },
      { id: 'n-2' },
    ]);

    const requeued = await reconciler.requeueStalePending();

    expect(requeued).toBe(2);
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenNthCalledWith(
      1,
      SEND_NOTIFICATION_JOB,
      { notificationId: 'n-1' },
      { ...SEND_JOB_OPTIONS, jobId: 'n-1' },
    );
    expect(queue.add).toHaveBeenNthCalledWith(
      2,
      SEND_NOTIFICATION_JOB,
      { notificationId: 'n-2' },
      { ...SEND_JOB_OPTIONS, jobId: 'n-2' },
    );
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      'Re-enqueued 2 stale notification(s)',
    );
  });

  it('does nothing (and logs nothing) when no row is stale', async () => {
    const requeued = await reconciler.requeueStalePending();

    expect(requeued).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });

  it('marks stale REDACTED rows FAILED instead of replaying them (the placeholder would be sent)', async () => {
    await reconciler.requeueStalePending();

    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: {
        status: NotificationStatus.PENDING,
        redacted: true,
        createdAt: { lt: tenMinutesAgo },
      },
      data: {
        status: NotificationStatus.FAILED,
        lastError: 'expired before delivery',
      },
    });
  });

  it('never re-enqueues a redacted row', async () => {
    await reconciler.requeueStalePending();

    const query = prisma.notification.findMany.mock.calls[0][0];
    expect(query.where.redacted).toBe(false);
  });

  it('is scheduled every 5 minutes', () => {
    // @Cron stores its schedule as metadata on the method; read it back.
    const cronOptions = Reflect.getMetadata(
      'SCHEDULE_CRON_OPTIONS',
      NotificationsReconciler.prototype.requeueStalePending,
    );

    expect(cronOptions.cronTime).toBe('0 */5 * * * *');
  });
});
