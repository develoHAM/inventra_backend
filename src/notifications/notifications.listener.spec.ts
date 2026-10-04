import { NotificationsListener } from './notifications.listener';
import { NotificationChannel } from '../generated/prisma/enums';
import { NotificationEvent } from './notification-events';
import { notificationTemplates } from './notification-templates';

describe('NotificationsListener', () => {
  let listener: NotificationsListener;
  let prisma: {
    company: { findUnique: jest.Mock };
    user: { findUnique: jest.Mock };
    order: { findFirst: jest.Mock };
    inventoryAudit: { findFirst: jest.Mock };
    companyStoreProduct: { findUnique: jest.Mock };
  };
  let notifications: {
    findUserEmail: jest.Mock;
    dispatch: jest.Mock;
    emailUsers: jest.Mock;
    findPlatformAdminIds: jest.Mock;
    findCompanyOwnerIds: jest.Mock;
    findCornerRecipientIds: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      company: { findUnique: jest.fn().mockResolvedValue({ name: 'UPL Co' }) },
      user: { findUnique: jest.fn() },
      order: { findFirst: jest.fn() },
      inventoryAudit: { findFirst: jest.fn() },
      companyStoreProduct: { findUnique: jest.fn() },
    };
    notifications = {
      findUserEmail: jest.fn().mockResolvedValue('owner@example.com'),
      dispatch: jest.fn().mockResolvedValue(undefined),
      emailUsers: jest.fn().mockResolvedValue(undefined),
      findPlatformAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      findCompanyOwnerIds: jest.fn().mockResolvedValue(['owner-1']),
      findCornerRecipientIds: jest
        .fn()
        .mockResolvedValue(['manager-1', 'owner-1']),
    };
    listener = new NotificationsListener(prisma as any, notifications as any);
  });

  describe('company.approved', () => {
    const event = { companyId: 'company-1', ownerUserId: 'owner-1' };

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

  describe('company.registered', () => {
    it('emails every platform admin', async () => {
      await listener.handleCompanyRegistered({ companyId: 'company-1' });

      expect(notifications.emailUsers).toHaveBeenCalledWith({
        userIds: ['admin-1'],
        eventType: NotificationEvent.COMPANY_REGISTERED,
        message: notificationTemplates.companyRegistered('UPL Co'),
      });
    });

    it('sends nothing when the company no longer exists', async () => {
      prisma.company.findUnique.mockResolvedValue(null);

      await listener.handleCompanyRegistered({ companyId: 'gone' });

      expect(notifications.emailUsers).not.toHaveBeenCalled();
    });
  });

  describe('member.joinRequested', () => {
    const event = { companyId: 'company-1', memberUserId: 'member-1' };

    it('emails the company owner(s), naming the member, excluding the member', async () => {
      prisma.user.findUnique.mockResolvedValue({ name: 'Sam' });

      await listener.handleMemberJoinRequested(event);

      expect(notifications.findCompanyOwnerIds).toHaveBeenCalledWith(
        'company-1',
      );
      expect(notifications.emailUsers).toHaveBeenCalledWith({
        userIds: ['owner-1'],
        excludeUserId: 'member-1',
        eventType: NotificationEvent.MEMBER_JOIN_REQUESTED,
        message: notificationTemplates.memberJoinRequested('Sam', 'UPL Co'),
      });
    });

    it('sends nothing when the member no longer exists', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await listener.handleMemberJoinRequested(event);

      expect(notifications.emailUsers).not.toHaveBeenCalled();
    });
  });

  describe('member.approved', () => {
    const event = { memberUserId: 'member-1', approvedByUserId: 'owner-1' };

    it("emails the member with their company's name, excluding the approver", async () => {
      prisma.user.findUnique.mockResolvedValue({ company: { name: 'UPL Co' } });

      await listener.handleMemberApproved(event);

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'member-1' },
        select: { company: { select: { name: true } } },
      });
      expect(notifications.emailUsers).toHaveBeenCalledWith({
        userIds: ['member-1'],
        excludeUserId: 'owner-1',
        eventType: NotificationEvent.MEMBER_APPROVED,
        message: notificationTemplates.memberApproved('UPL Co'),
      });
    });

    it('sends nothing when the member is gone or has no company', async () => {
      prisma.user.findUnique.mockResolvedValue({ company: null });
      await listener.handleMemberApproved(event);

      prisma.user.findUnique.mockResolvedValue(null);
      await listener.handleMemberApproved(event);

      expect(notifications.emailUsers).not.toHaveBeenCalled();
    });
  });

  describe('order.created', () => {
    const event = {
      orderId: 'order-1',
      cornerId: 'corner-1',
      createdByUserId: 'manager-1',
    };

    it('emails the corner recipients minus the creator, with the item count from _count', async () => {
      prisma.order.findFirst.mockResolvedValue({
        title: 'Weekend restock',
        companyStore: { name: 'Corner A' },
        _count: { orderItems: 2 },
      });

      await listener.handleOrderCreated(event);

      // scoped to the corner from the event, counting items instead of loading them
      expect(prisma.order.findFirst).toHaveBeenCalledWith({
        where: { id: 'order-1', companyStoreId: 'corner-1' },
        select: {
          title: true,
          companyStore: { select: { name: true } },
          _count: { select: { orderItems: true } },
        },
      });
      expect(notifications.findCornerRecipientIds).toHaveBeenCalledWith(
        'corner-1',
      );
      expect(notifications.emailUsers).toHaveBeenCalledWith({
        userIds: ['manager-1', 'owner-1'],
        excludeUserId: 'manager-1',
        eventType: NotificationEvent.ORDER_CREATED,
        message: notificationTemplates.orderCreated(
          'Corner A',
          'Weekend restock',
          2,
        ),
      });
    });

    it('sends nothing when the order no longer exists', async () => {
      prisma.order.findFirst.mockResolvedValue(null);

      await listener.handleOrderCreated(event);

      expect(notifications.emailUsers).not.toHaveBeenCalled();
    });
  });

  describe('audit.applied', () => {
    const event = {
      auditId: 'audit-1',
      cornerId: 'corner-1',
      appliedByUserId: 'owner-1',
    };

    it('emails the corner recipients minus the applier', async () => {
      prisma.inventoryAudit.findFirst.mockResolvedValue({
        title: 'Monthly count',
        companyStore: { name: 'Corner A' },
        _count: { inventoryAuditItems: 3 },
      });

      await listener.handleAuditApplied(event);

      expect(notifications.emailUsers).toHaveBeenCalledWith({
        userIds: ['manager-1', 'owner-1'],
        excludeUserId: 'owner-1',
        eventType: NotificationEvent.AUDIT_APPLIED,
        message: notificationTemplates.auditApplied(
          'Corner A',
          'Monthly count',
          3,
        ),
      });
    });

    it('sends nothing when the audit no longer exists', async () => {
      prisma.inventoryAudit.findFirst.mockResolvedValue(null);

      await listener.handleAuditApplied(event);

      expect(notifications.emailUsers).not.toHaveBeenCalled();
    });
  });

  describe('stock.belowTarget', () => {
    const event = {
      placementId: 41,
      availableQuantity: 7,
      targetStockQuantity: 10,
    };

    it('emails the corner recipients with NO actor exclusion (a state warning)', async () => {
      prisma.companyStoreProduct.findUnique.mockResolvedValue({
        companyStoreId: 'corner-1',
        companyStore: { name: 'Corner A' },
        product: { name: 'Cola 500ml' },
      });

      await listener.handleStockBelowTarget(event);

      expect(notifications.findCornerRecipientIds).toHaveBeenCalledWith(
        'corner-1',
      );
      const call = notifications.emailUsers.mock.calls[0][0];
      expect(call).toEqual({
        userIds: ['manager-1', 'owner-1'],
        eventType: NotificationEvent.STOCK_BELOW_TARGET,
        message: notificationTemplates.stockBelowTarget(
          'Corner A',
          'Cola 500ml',
          7,
          10,
        ),
      });
      expect(call).not.toHaveProperty('excludeUserId');
    });

    it('sends nothing when the placement no longer exists', async () => {
      prisma.companyStoreProduct.findUnique.mockResolvedValue(null);

      await listener.handleStockBelowTarget(event);

      expect(notifications.emailUsers).not.toHaveBeenCalled();
    });
  });

  describe('account.passwordReset', () => {
    it('emails the account owner a "password changed" notice (nobody excluded)', async () => {
      await listener.handleAccountPasswordReset({ userId: 'user-1' });

      const call = notifications.emailUsers.mock.calls[0][0];
      expect(call).toEqual({
        userIds: ['user-1'],
        eventType: NotificationEvent.ACCOUNT_PASSWORD_RESET,
        message: notificationTemplates.passwordReset(),
      });
      // the owner IS the actor here — excluding them would send nothing
      expect(call).not.toHaveProperty('excludeUserId');
    });

    it('needs no database lookup (the template has no variables)', async () => {
      await listener.handleAccountPasswordReset({ userId: 'user-1' });

      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.company.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('notificationTemplates.passwordReset', () => {
    it('has a subject and tells the user what to do if it was not them', () => {
      const message = notificationTemplates.passwordReset();

      expect(message.subject).toBe('[Inventra] 비밀번호가 변경되었습니다');
      expect(message.body).toContain('본인이 변경하지 않았다면');
      expect(message.body).toContain('비밀번호 찾기');
    });
  });
});
