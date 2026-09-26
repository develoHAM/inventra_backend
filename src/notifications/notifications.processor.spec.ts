import { Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { NotificationsProcessor } from './notifications.processor';
import {
  NotificationChannel,
  NotificationStatus,
} from '../generated/prisma/enums';
import { SEND_NOTIFICATION_JOB } from './notifications.constants';

describe('NotificationsProcessor', () => {
  let processor: NotificationsProcessor;
  let prisma: {
    notification: { findUnique: jest.Mock; update: jest.Mock };
  };
  let email: { send: jest.Mock };

  const pendingEmail = {
    id: 'n-1',
    channel: NotificationChannel.EMAIL,
    status: NotificationStatus.PENDING,
    recipientAddress: 'owner@example.com',
    subject: 'Approved',
    body: 'Your company was approved.',
  };

  // A minimal stand-in for a BullMQ Job: only the fields process() reads.
  const makeJob = (
    overrides: { name?: string; attemptsMade?: number; attempts?: number } = {},
  ) =>
    ({
      name: overrides.name ?? SEND_NOTIFICATION_JOB,
      data: { notificationId: 'n-1' },
      attemptsMade: overrides.attemptsMade ?? 0,
      opts: { attempts: overrides.attempts ?? 3 },
    }) as any;

  beforeEach(() => {
    prisma = {
      notification: {
        findUnique: jest.fn().mockResolvedValue(pendingEmail),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    email = { send: jest.fn().mockResolvedValue(undefined) };
    processor = new NotificationsProcessor(prisma as any, email as any);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('rejects an unknown job name as unrecoverable, without touching the database', async () => {
    await expect(
      processor.process(makeJob({ name: 'reconcile' })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(prisma.notification.findUnique).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
  });

  it('sends through the email channel, then marks the row SENT', async () => {
    await processor.process(makeJob());

    expect(prisma.notification.findUnique).toHaveBeenCalledWith({
      where: { id: 'n-1' },
    });
    expect(email.send).toHaveBeenCalledWith({
      to: 'owner@example.com',
      subject: 'Approved',
      body: 'Your company was approved.',
    });
    expect(prisma.notification.update).toHaveBeenCalledWith({
      where: { id: 'n-1' },
      data: {
        status: NotificationStatus.SENT,
        sentAt: expect.any(Date),
        attempts: { increment: 1 },
        lastError: null,
      },
    });
  });

  it('passes an undefined subject when the row has none', async () => {
    prisma.notification.findUnique.mockResolvedValue({
      ...pendingEmail,
      subject: null,
    });

    await processor.process(makeJob());

    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({ subject: undefined }),
    );
  });

  it('skips a row that is already SENT (duplicate delivery is harmless)', async () => {
    prisma.notification.findUnique.mockResolvedValue({
      ...pendingEmail,
      status: NotificationStatus.SENT,
    });

    await processor.process(makeJob());

    expect(email.send).not.toHaveBeenCalled();
    expect(prisma.notification.update).not.toHaveBeenCalled();
  });

  it('does nothing when the row no longer exists', async () => {
    prisma.notification.findUnique.mockResolvedValue(null);

    await processor.process(makeJob());

    expect(email.send).not.toHaveBeenCalled();
    expect(prisma.notification.update).not.toHaveBeenCalled();
  });

  it('on a non-final failure: records the error, keeps the row PENDING, rethrows for a retry', async () => {
    email.send.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      processor.process(makeJob({ attemptsMade: 0, attempts: 3 })),
    ).rejects.toThrow('ECONNREFUSED');

    expect(prisma.notification.update).toHaveBeenCalledWith({
      where: { id: 'n-1' },
      data: { attempts: { increment: 1 }, lastError: 'ECONNREFUSED' },
    });
  });

  it('on the final failure: marks the row FAILED, and still rethrows', async () => {
    email.send.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      processor.process(makeJob({ attemptsMade: 2, attempts: 3 })),
    ).rejects.toThrow('ECONNREFUSED');

    expect(prisma.notification.update).toHaveBeenCalledWith({
      where: { id: 'n-1' },
      data: {
        attempts: { increment: 1 },
        lastError: 'ECONNREFUSED',
        status: NotificationStatus.FAILED,
      },
    });
  });

  it('treats a channel with no sender yet as a failed attempt', async () => {
    prisma.notification.findUnique.mockResolvedValue({
      ...pendingEmail,
      channel: NotificationChannel.SMS,
    });

    await expect(processor.process(makeJob())).rejects.toThrow(
      'No sender for channel SMS',
    );
    expect(email.send).not.toHaveBeenCalled();
    expect(prisma.notification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastError: 'No sender for channel SMS',
        }),
      }),
    );
  });
});
