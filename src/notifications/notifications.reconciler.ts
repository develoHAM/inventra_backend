import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationStatus } from '../generated/prisma/enums';
import {
  NOTIFICATIONS_QUEUE,
  SEND_JOB_OPTIONS,
  SEND_NOTIFICATION_JOB,
} from './notifications.constants';

@Injectable()
export class NotificationsReconciler {
  private readonly logger = new Logger(NotificationsReconciler.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(NOTIFICATIONS_QUEUE) private readonly queue: Queue,
  ) {}

  /** Re-enqueue notifications stuck in PENDING (e.g. Redis was down when dispatch() ran). */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async requeueStalePending(): Promise<number> {
    const staleBefore = new Date(Date.now() - 10 * 60 * 1000);

    // A redacted row's real text lived only in its job; replaying it would send
    // the placeholder. The secret (a code) has expired anyway: record the failure.
    await this.prisma.notification.updateMany({
      where: {
        status: NotificationStatus.PENDING,
        redacted: true,
        createdAt: { lt: staleBefore },
      },
      data: {
        status: NotificationStatus.FAILED,
        lastError: 'expired before delivery',
      },
    });

    const stale = await this.prisma.notification.findMany({
      where: {
        status: NotificationStatus.PENDING,
        redacted: false,
        createdAt: { lt: staleBefore },
      },
      select: { id: true },
      take: 100,
    });

    for (const notification of stale) {
      // Same jobId as the original: if that job still exists, BullMQ ignores this add.
      await this.queue.add(
        SEND_NOTIFICATION_JOB,
        { notificationId: notification.id },
        { ...SEND_JOB_OPTIONS, jobId: notification.id },
      );
    }

    if (stale.length > 0) {
      this.logger.warn(`Re-enqueued ${stale.length} stale notification(s)`);
    }
    return stale.length;
  }
}
