import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationChannel, UserStatus } from '../generated/prisma/enums';
import {
  NOTIFICATIONS_QUEUE,
  REDACTED_SEND_JOB_OPTIONS,
  SEND_JOB_OPTIONS,
  SEND_NOTIFICATION_JOB,
} from './notifications.constants';
import type { SendNotificationJobData } from './notifications.constants';
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
  /**
   * Set for secret text (verification codes): the row stores this placeholder
   * and the real `body` travels only inside the queue job.
   */
  redactedBody?: string;
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(NOTIFICATIONS_QUEUE) private readonly queue: Queue,
    private readonly devices: DevicesService,
  ) {}

  async dispatch(input: DispatchInput): Promise<void> {
    const isRedacted = input.redactedBody !== undefined;
    const notification = await this.prisma.notification.create({
      data: {
        eventType: input.eventType,
        channel: input.channel,
        recipientUserId: input.recipientUserId ?? null,
        recipientAddress: input.recipientAddress,
        subject: input.subject ?? null,
        // a redacted row never holds the secret text
        body: isRedacted ? input.redactedBody! : input.body,
        data: input.data,
        redacted: isRedacted,
      },
    });
    const jobData: SendNotificationJobData = isRedacted
      ? { notificationId: notification.id, body: input.body }
      : { notificationId: notification.id };
    await this.queue.add(SEND_NOTIFICATION_JOB, jobData, {
      ...(isRedacted ? REDACTED_SEND_JOB_OPTIONS : SEND_JOB_OPTIONS),
      jobId: notification.id,
    });
  }

  /** Where this profile's notifications go: its company's contact email (independent of how the person signs in). */
  async findUserEmail(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { contactEmail: true },
    });
    return user?.contactEmail ?? null;
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

  /** Every active manager whose branch is this corner, then the company's owner(s). */
  async findCornerRecipientIds(cornerId: string): Promise<string[]> {
    const corner = await this.prisma.companyStore.findUnique({
      where: { id: cornerId },
      select: { companyId: true },
    });
    if (!corner) return [];
    const managers = await this.prisma.user.findMany({
      where: {
        companyStoreId: cornerId,
        role: { code: 'MANAGER' },
        status: UserStatus.ACTIVE,
        deletedAt: null,
      },
      select: { id: true },
    });
    const ownerIds = await this.findCompanyOwnerIds(corner.companyId);
    return [...managers.map((manager) => manager.id), ...ownerIds];
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
      // A device belongs to the person's account, so each recipient profile
      // leads to its account's devices. One row per device (each succeeds,
      // retries or dies on its own), recording the profile it is for.
      const profiles = await this.prisma.user.findMany({
        where: { id: { in: recipientIds } },
        select: { id: true, accountId: true },
      });
      const devices = await this.devices.findTokens([
        ...new Set(profiles.map((profile) => profile.accountId)),
      ]);
      for (const profile of profiles) {
        const profileDevices = devices.filter(
          (device) => device.accountId === profile.accountId,
        );
        for (const device of profileDevices) {
          await this.dispatch({
            eventType: input.eventType,
            channel: NotificationChannel.PUSH,
            recipientUserId: profile.id,
            recipientAddress: device.token,
            subject: input.message.subject,
            body: input.message.body,
            data: input.data,
          });
        }
      }
    }
  }

  /**
   * Notify a person about their sign-in itself, not about a company (today:
   * the password reset): one email to the account's password-login address,
   * one push per device. The rows record no profile.
   */
  async notifyAccount(input: {
    accountId: string;
    eventType: NotificationEventName;
    message: RenderedMessage;
  }): Promise<void> {
    const channels = EVENT_CHANNELS[input.eventType];

    if (channels.includes(NotificationChannel.EMAIL)) {
      const passwordLogin = await this.prisma.userLoginMethod.findFirst({
        where: { accountId: input.accountId, method: 'local' },
        select: { email: true },
      });
      if (passwordLogin?.email) {
        await this.dispatch({
          eventType: input.eventType,
          channel: NotificationChannel.EMAIL,
          recipientAddress: passwordLogin.email,
          subject: input.message.subject,
          body: input.message.body,
        });
      }
    }

    if (channels.includes(NotificationChannel.PUSH)) {
      const devices = await this.devices.findTokens([input.accountId]);
      for (const device of devices) {
        await this.dispatch({
          eventType: input.eventType,
          channel: NotificationChannel.PUSH,
          recipientAddress: device.token,
          subject: input.message.subject,
          body: input.message.body,
        });
      }
    }
  }
}
