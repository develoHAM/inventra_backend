import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationChannel, UserStatus } from '../generated/prisma/enums';
import {
  NOTIFICATIONS_QUEUE,
  SEND_JOB_OPTIONS,
  SEND_NOTIFICATION_JOB,
} from './notifications.constants';
import type { RenderedMessage } from './notification-templates';

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
      { ...SEND_JOB_OPTIONS, jobId: notification.id },
    );
  }

  async findUserEmail(userId: string): Promise<string | null> {
    const loginMethod = await this.prisma.userLoginMethod.findFirst({
      where: { userId: userId, method: 'local', email: { not: null } },
      select: { email: true },
    });
    return loginMethod?.email ?? null;
  }

  async findPlatformAdminIds(): Promise<string[]> {
    const admins = await this.prisma.user.findMany({
      where: {
        role: { code: 'ADMIN' },
        status: UserStatus.ACTIVE,
        deletedAt: null,
      },
      select: { id: true },
    });
    return admins.map((admin) => admin.id);
  }

  async findCompanyOwnerIds(companyId: string): Promise<string[]> {
    const owners = await this.prisma.user.findMany({
      where: {
        companyId: companyId,
        role: { code: 'OWNER' },
        status: UserStatus.ACTIVE,
        deletedAt: null,
      },
      select: { id: true },
    });
    return owners.map((owner) => owner.id);
  }

  /** Corner manager (if any) + the corner company's owner(s). */
  async findCornerRecipientIds(cornerId: string): Promise<string[]> {
    const corner = await this.prisma.companyStore.findUnique({
      where: { id: cornerId },
      select: { companyId: true, managerUserId: true },
    });
    if (!corner) return [];
    const ownerIds = await this.findCompanyOwnerIds(corner.companyId);
    return corner.managerUserId
      ? [corner.managerUserId, ...ownerIds]
      : ownerIds;
  }

  /** Email each user once (deduplicated), skipping the actor and users with no email. */
  async emailUsers(input: {
    userIds: string[];
    excludeUserId?: string;
    eventType: string;
    message: RenderedMessage;
  }): Promise<void> {
    const recipientIds = [...new Set(input.userIds)].filter(
      (userId) => userId !== input.excludeUserId,
    );
    for (const userId of recipientIds) {
      const email = await this.findUserEmail(userId);
      if (!email) continue;
      await this.dispatch({
        eventType: input.eventType,
        channel: NotificationChannel.EMAIL,
        recipientUserId: userId,
        recipientAddress: email,
        subject: input.message.subject,
        body: input.message.body,
      });
    }
  }
}
