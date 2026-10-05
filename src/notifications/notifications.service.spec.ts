import { NotificationsService } from './notifications.service';
import { NotificationChannel, UserStatus } from '../generated/prisma/enums';
import {
  SEND_JOB_OPTIONS,
  SEND_NOTIFICATION_JOB,
} from './notifications.constants';

describe('NotificationsService', () => {
  let service: NotificationsService;
  let prisma: {
    notification: { create: jest.Mock };
    userLoginMethod: { findFirst: jest.Mock };
    user: { findMany: jest.Mock };
    companyStore: { findUnique: jest.Mock };
  };
  let queue: { add: jest.Mock };
  let devices: { findTokens: jest.Mock };

  beforeEach(() => {
    prisma = {
      notification: {
        create: jest.fn().mockResolvedValue({ id: 'notification-1' }),
      },
      userLoginMethod: { findFirst: jest.fn() },
      user: { findMany: jest.fn().mockResolvedValue([]) },
      companyStore: { findUnique: jest.fn() },
    };
    queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    devices = { findTokens: jest.fn().mockResolvedValue([]) };
    // constructor: (prisma, queue, devices) — the queue is injected by token in
    // the app, but a unit test can just pass the mock positionally.
    service = new NotificationsService(
      prisma as any,
      queue as any,
      devices as any,
    );
  });

  describe('dispatch', () => {
    it('writes the Notification row first, then enqueues a job carrying only its id', async () => {
      await service.dispatch({
        eventType: 'company.approved',
        channel: NotificationChannel.EMAIL,
        recipientUserId: 'owner-1',
        recipientAddress: 'owner@example.com',
        subject: 'Approved',
        body: 'Your company was approved.',
      });

      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: {
          eventType: 'company.approved',
          channel: NotificationChannel.EMAIL,
          recipientUserId: 'owner-1',
          recipientAddress: 'owner@example.com',
          subject: 'Approved',
          body: 'Your company was approved.',
        },
      });
      // jobId = the row id, so re-enqueueing the same notification is a no-op
      expect(queue.add).toHaveBeenCalledWith(
        SEND_NOTIFICATION_JOB,
        { notificationId: 'notification-1' },
        { ...SEND_JOB_OPTIONS, jobId: 'notification-1' },
      );
      // the row must exist before the worker could possibly look for it
      expect(
        prisma.notification.create.mock.invocationCallOrder[0],
      ).toBeLessThan(queue.add.mock.invocationCallOrder[0]);
    });

    it('stores null for the optional recipientUserId and subject when omitted', async () => {
      await service.dispatch({
        eventType: 'reservation.created',
        channel: NotificationChannel.SMS,
        recipientAddress: '01012345678',
        body: '예약이 확정되었습니다.',
      });

      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          recipientUserId: null,
          subject: null,
        }),
      });
    });

    it('uses the shared retry policy (3 attempts, exponential backoff, drop on success)', () => {
      expect(SEND_JOB_OPTIONS).toEqual({
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
      });
    });
  });

  describe('findUserEmail', () => {
    it("returns the email of the user's local (password) login method", async () => {
      prisma.userLoginMethod.findFirst.mockResolvedValue({
        email: 'owner@example.com',
      });

      const email = await service.findUserEmail('owner-1');

      expect(email).toBe('owner@example.com');
      expect(prisma.userLoginMethod.findFirst).toHaveBeenCalledWith({
        where: { userId: 'owner-1', method: 'local', email: { not: null } },
        select: { email: true },
      });
    });

    it('returns null when the user has no email login', async () => {
      prisma.userLoginMethod.findFirst.mockResolvedValue(null);

      expect(await service.findUserEmail('ghost')).toBeNull();
    });
  });

  describe('recipient finders', () => {
    it('findPlatformAdminIds returns active, non-deleted ADMIN ids', async () => {
      prisma.user.findMany.mockResolvedValue([
        { id: 'admin-1' },
        { id: 'admin-2' },
      ]);

      expect(await service.findPlatformAdminIds()).toEqual([
        'admin-1',
        'admin-2',
      ]);
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: {
          role: { code: 'ADMIN' },
          status: UserStatus.ACTIVE,
          deletedAt: null,
        },
        select: { id: true },
      });
    });

    it("findCompanyOwnerIds returns that company's active OWNER ids", async () => {
      prisma.user.findMany.mockResolvedValue([{ id: 'owner-1' }]);

      expect(await service.findCompanyOwnerIds('company-1')).toEqual([
        'owner-1',
      ]);
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: {
          companyId: 'company-1',
          role: { code: 'OWNER' },
          status: UserStatus.ACTIVE,
          deletedAt: null,
        },
        select: { id: true },
      });
    });

    it('findCornerRecipientIds returns the corner manager first, then the owners', async () => {
      prisma.companyStore.findUnique.mockResolvedValue({
        companyId: 'company-1',
        managerUserId: 'manager-1',
      });
      prisma.user.findMany.mockResolvedValue([{ id: 'owner-1' }]);

      expect(await service.findCornerRecipientIds('corner-1')).toEqual([
        'manager-1',
        'owner-1',
      ]);
      expect(prisma.companyStore.findUnique).toHaveBeenCalledWith({
        where: { id: 'corner-1' },
        select: { companyId: true, managerUserId: true },
      });
    });

    it('findCornerRecipientIds returns just the owners when the corner has no manager', async () => {
      prisma.companyStore.findUnique.mockResolvedValue({
        companyId: 'company-1',
        managerUserId: null,
      });
      prisma.user.findMany.mockResolvedValue([{ id: 'owner-1' }]);

      expect(await service.findCornerRecipientIds('corner-1')).toEqual([
        'owner-1',
      ]);
    });

    it('findCornerRecipientIds returns nobody for an unknown corner', async () => {
      prisma.companyStore.findUnique.mockResolvedValue(null);

      expect(await service.findCornerRecipientIds('ghost')).toEqual([]);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });
  });

  describe('notifyUsers', () => {
    const message = { subject: 'Hello', body: 'Body' };

    beforeEach(() => {
      // Every user has an email derived from their id, except 'no-email'.
      jest
        .spyOn(service, 'findUserEmail')
        .mockImplementation(async (userId: string) =>
          userId === 'no-email' ? null : `${userId}@example.com`,
        );
      jest.spyOn(service, 'dispatch').mockResolvedValue(undefined);
    });

    it('dispatches one EMAIL per user with the rendered message', async () => {
      await service.notifyUsers({
        userIds: ['manager-1', 'owner-1'],
        eventType: 'order.created',
        message: message,
      });

      expect(service.dispatch).toHaveBeenCalledWith({
        eventType: 'order.created',
        channel: NotificationChannel.EMAIL,
        recipientUserId: 'manager-1',
        recipientAddress: 'manager-1@example.com',
        subject: 'Hello',
        body: 'Body',
      });
      expect(service.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: NotificationChannel.EMAIL,
          recipientUserId: 'owner-1',
        }),
      );
    });

    it('dispatches one PUSH per registered device (title = subject, address = token)', async () => {
      devices.findTokens.mockResolvedValue([
        { userId: 'owner-1', token: 'owner-phone' },
        { userId: 'owner-1', token: 'owner-laptop' },
      ]);

      await service.notifyUsers({
        userIds: ['owner-1'],
        eventType: 'order.created',
        message: message,
      });

      expect(devices.findTokens).toHaveBeenCalledWith(['owner-1']);
      for (const token of ['owner-phone', 'owner-laptop']) {
        expect(service.dispatch).toHaveBeenCalledWith({
          eventType: 'order.created',
          channel: NotificationChannel.PUSH,
          recipientUserId: 'owner-1',
          recipientAddress: token,
          subject: 'Hello',
          body: 'Body',
        });
      }
      // 1 email + 2 devices
      expect(service.dispatch).toHaveBeenCalledTimes(3);
    });

    it('a user with no devices still gets the email', async () => {
      devices.findTokens.mockResolvedValue([]);

      await service.notifyUsers({
        userIds: ['owner-1'],
        eventType: 'order.created',
        message: message,
      });

      expect(service.dispatch).toHaveBeenCalledTimes(1);
      expect(service.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ channel: NotificationChannel.EMAIL }),
      );
    });

    it('a user with no email still gets the push', async () => {
      devices.findTokens.mockResolvedValue([
        { userId: 'no-email', token: 'their-phone' },
      ]);

      await service.notifyUsers({
        userIds: ['no-email'],
        eventType: 'order.created',
        message: message,
      });

      expect(service.dispatch).toHaveBeenCalledTimes(1);
      expect(service.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: NotificationChannel.PUSH,
          recipientAddress: 'their-phone',
        }),
      );
    });

    it('notifies a person only once even if listed twice (manager who is also the owner)', async () => {
      await service.notifyUsers({
        userIds: ['owner-1', 'owner-1'],
        eventType: 'order.created',
        message: message,
      });

      expect(service.dispatch).toHaveBeenCalledTimes(1); // one email
      expect(devices.findTokens).toHaveBeenCalledWith(['owner-1']);
    });

    it('never notifies the actor, on any channel', async () => {
      await service.notifyUsers({
        userIds: ['manager-1', 'owner-1'],
        excludeUserId: 'manager-1',
        eventType: 'order.created',
        message: message,
      });

      expect(service.dispatch).toHaveBeenCalledTimes(1);
      expect(service.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ recipientUserId: 'owner-1' }),
      );
      expect(devices.findTokens).toHaveBeenCalledWith(['owner-1']);
    });

    it('does nothing — not even a device lookup — for an empty recipient list', async () => {
      await service.notifyUsers({
        userIds: ['manager-1'],
        excludeUserId: 'manager-1', // the only recipient was the actor
        eventType: 'order.created',
        message: message,
      });

      expect(service.dispatch).not.toHaveBeenCalled();
      expect(devices.findTokens).not.toHaveBeenCalled();
    });
  });
});
