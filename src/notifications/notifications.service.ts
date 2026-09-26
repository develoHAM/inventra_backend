import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationChannel } from '../generated/prisma/enums';
import {
  NOTIFICATIONS_QUEUE,
  SEND_JOB_OPTIONS,
  SEND_NOTIFICATION_JOB,
} from './notifications.constants';

export interface DispatchInput {
  eventType: string;
  channel: NotificationChannel;
  recipientUserId?: string;
  recipientAddress: string;
  subject?: string;
  body: string;
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(NOTIFICATIONS_QUEUE) private readonly queue: Queue,
  ) {}

  async dispatch(input: DispatchInput): Promise<void> {
    const notification = await this.prisma.notification.create({
      data: {
        eventType: input.eventType,
        channel: input.channel,
        recipientUserId: input.recipientUserId ?? null,
        recipientAddress: input.recipientAddress,
        subject: input.subject ?? null,
        body: input.body,
      },
    });
    await this.queue.add(
      SEND_NOTIFICATION_JOB,
      { notificationId: notification.id },
      SEND_JOB_OPTIONS,
    );
  }

  async findUserEmail(userId: string): Promise<string | null> {
    const loginMethod = await this.prisma.userLoginMethod.findFirst({
      where: { userId: userId, method: 'local', email: { not: null } },
      select: { email: true },
    });
    return loginMethod?.email ?? null;
  }
}
