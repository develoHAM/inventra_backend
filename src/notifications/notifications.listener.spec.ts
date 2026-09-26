import { NotificationsListener } from './notifications.listener';
import { NotificationChannel } from '../generated/prisma/enums';
import { NotificationEvent } from './notification-events';
import { notificationTemplates } from './notification-templates';

describe('NotificationsListener', () => {
  let listener: NotificationsListener;
  let prisma: { company: { findUnique: jest.Mock } };
  let notifications: { findUserEmail: jest.Mock; dispatch: jest.Mock };

  const event = { companyId: 'company-1', ownerUserId: 'owner-1' };

  beforeEach(() => {
    prisma = {
      company: { findUnique: jest.fn().mockResolvedValue({ name: 'UPL Co' }) },
    };
    notifications = {
      findUserEmail: jest.fn().mockResolvedValue('owner@example.com'),
      dispatch: jest.fn().mockResolvedValue(undefined),
    };
    listener = new NotificationsListener(prisma as any, notifications as any);
  });

  describe('company.approved', () => {
    it('emails the owner the rendered companyApproved template', async () => {
      await listener.handleCompanyApproved(event);

      const expected = notificationTemplates.companyApproved('UPL Co');
      expect(prisma.company.findUnique).toHaveBeenCalledWith({
        where: { id: 'company-1' },
        select: { name: true },
      });
      expect(notifications.findUserEmail).toHaveBeenCalledWith('owner-1');
      expect(notifications.dispatch).toHaveBeenCalledWith({
        eventType: NotificationEvent.COMPANY_APPROVED,
        channel: NotificationChannel.EMAIL,
        recipientUserId: 'owner-1',
        recipientAddress: 'owner@example.com',
        subject: expected.subject,
        body: expected.body,
      });
      expect(expected.body).toContain('UPL Co');
    });

    it('sends nothing when the owner has no email login', async () => {
      notifications.findUserEmail.mockResolvedValue(null);

      await listener.handleCompanyApproved(event);

      expect(notifications.dispatch).not.toHaveBeenCalled();
    });

    it('sends nothing when the company no longer exists', async () => {
      prisma.company.findUnique.mockResolvedValue(null);

      await listener.handleCompanyApproved(event);

      expect(notifications.dispatch).not.toHaveBeenCalled();
    });
  });
});
