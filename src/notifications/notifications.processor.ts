import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import {
  NotificationChannel,
  NotificationStatus,
} from '../generated/prisma/enums';
import { EmailChannel } from './channels/email.channel';
import { NotificationSender } from './channels/notification-channel';
import {
  NOTIFICATIONS_QUEUE,
  SEND_NOTIFICATION_JOB,
} from './notifications.constants';

@Processor(NOTIFICATIONS_QUEUE)
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailChannel,
  ) {
    super();
  }

  async process(job: Job<{ notificationId: string }>): Promise<void> {
    // A WorkerHost receives EVERY job on the queue, whatever its name.
    // Fail loudly (no retries) on anything that isn't a send job.
    if (job.name !== SEND_NOTIFICATION_JOB) {
      throw new UnrecoverableError(`Unknown notifications job "${job.name}"`);
    }

    const notification = await this.prisma.notification.findUnique({
      where: { id: job.data.notificationId },
    });
    if (!notification || notification.status === NotificationStatus.SENT)
      return;

    try {
      await this.senderFor(notification.channel).send({
        to: notification.recipientAddress,
        subject: notification.subject ?? undefined,
        body: notification.body,
      });
      await this.prisma.notification.update({
        where: { id: notification.id },
        data: {
          status: NotificationStatus.SENT,
          sentAt: new Date(),
          attempts: { increment: 1 },
          lastError: null,
        },
      });
    } catch (error) {
      const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      await this.prisma.notification.update({
        where: { id: notification.id },
        data: {
          attempts: { increment: 1 },
          lastError: error instanceof Error ? error.message : String(error),
          ...(isLastAttempt ? { status: NotificationStatus.FAILED } : {}),
        },
      });
      this.logger.warn(
        `Notification ${notification.id} failed (attempt ${job.attemptsMade + 1})`,
      );
      throw error; // BullMQ schedules the retry
    }
  }

  private senderFor(channel: NotificationChannel): NotificationSender {
    switch (channel) {
      case NotificationChannel.EMAIL:
        return this.email;
      default:
        throw new Error(`No sender for channel ${channel}`);
    }
  }
}
