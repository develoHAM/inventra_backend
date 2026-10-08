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
import { DevicesService } from '../devices/devices.service';
import { EVENT_CHANNELS } from './event-channels';
import type { NotificationEventName } from './event-channels';

export interface DispatchInput {
  eventType: string;
  channel: NotificationChannel;
  recipientUserId?: string;
  recipientAddress: string;
  subject?: string;
  body: string;
  data?: Record<string, string>; // push deep-link payload
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(NOTIFICATIONS_QUEUE) private readonly queue: Queue,
    private readonly devices: DevicesService,
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
        data: input.data,
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

  /**
   * Notify users of an event on every channel EVENT_CHANNELS lists for it:
   * one EMAIL per user with an email login, one PUSH per registered device.
   * Duplicates are collapsed and the actor is never notified.
   */
  async notifyUsers(input: {
    userIds: string[];
    excludeUserId?: string;
    eventType: NotificationEventName;
    message: RenderedMessage;
    data?: Record<string, string>; // deep-link ids, sent with push only
  }): Promise<void> {
    const recipientIds = [...new Set(input.userIds)].filter(
      (userId) => userId !== input.excludeUserId,
    );
    if (recipientIds.length === 0) return;

    const channels = EVENT_CHANNELS[input.eventType];

    if (channels.includes(NotificationChannel.EMAIL)) {
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

    if (channels.includes(NotificationChannel.PUSH)) {
      // One row per device: each succeeds, retries or dies on its own.
      const devices = await this.devices.findTokens(recipientIds);
      for (const device of devices) {
        await this.dispatch({
          eventType: input.eventType,
          channel: NotificationChannel.PUSH,
          recipientUserId: device.userId,
          recipientAddress: device.token,
          subject: input.message.subject,
          body: input.message.body,
          data: input.data,
        });
      }
    }
  }
}
