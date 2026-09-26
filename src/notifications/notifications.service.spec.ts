import { NotificationsService } from './notifications.service';
import { NotificationChannel } from '../generated/prisma/enums';
import {
  SEND_JOB_OPTIONS,
  SEND_NOTIFICATION_JOB,
} from './notifications.constants';

describe('NotificationsService', () => {
  let service: NotificationsService;
  let prisma: {
    notification: { create: jest.Mock };
    userLoginMethod: { findFirst: jest.Mock };
  };
  let queue: { add: jest.Mock };

  beforeEach(() => {
    prisma = {
      notification: {
        create: jest.fn().mockResolvedValue({ id: 'notification-1' }),
      },
      userLoginMethod: { findFirst: jest.fn() },
    };
    queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    // constructor: (prisma, queue) — the queue is injected by token in the app,
    // but a unit test can just pass the mock positionally.
    service = new NotificationsService(prisma as any, queue as any);
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
      expect(queue.add).toHaveBeenCalledWith(
        SEND_NOTIFICATION_JOB,
        { notificationId: 'notification-1' },
        SEND_JOB_OPTIONS,
      );
      // the row must exist before the worker could possibly look for it
      expect(prisma.notification.create.mock.invocationCallOrder[0]).toBeLessThan(
        queue.add.mock.invocationCallOrder[0],
      );
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
});
