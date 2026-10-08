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
    notifyUsers: jest.Mock;
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
      notifyUsers: jest.fn().mockResolvedValue(undefined),
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

    it('notifies the owner with the companyApproved template (email + push via notifyUsers)', async () => {
      await listener.handleCompanyApproved(event);

      expect(prisma.company.findUnique).toHaveBeenCalledWith({
        where: { id: 'company-1' },
        select: { name: true },
      });
      const call = notifications.notifyUsers.mock.calls[0][0];
      expect(call).toEqual({
        userIds: ['owner-1'],
        eventType: NotificationEvent.COMPANY_APPROVED,
        message: notificationTemplates.companyApproved('UPL Co'),
        data: { companyId: 'company-1' },
      });
      // approved by the platform admin, not by the owner: nobody to exclude
      expect(call).not.toHaveProperty('excludeUserId');
      expect(notifications.dispatch).not.toHaveBeenCalled();
    });

    it('sends nothing when the company no longer exists', async () => {
      prisma.company.findUnique.mockResolvedValue(null);

      await listener.handleCompanyApproved(event);

      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });
  });

  describe('company.registered', () => {
    it('emails every platform admin', async () => {
      await listener.handleCompanyRegistered({ companyId: 'company-1' });

      expect(notifications.notifyUsers).toHaveBeenCalledWith({
        userIds: ['admin-1'],
        eventType: NotificationEvent.COMPANY_REGISTERED,
        message: notificationTemplates.companyRegistered('UPL Co'),
        data: { companyId: 'company-1' },
      });
    });

    it('sends nothing when the company no longer exists', async () => {
      prisma.company.findUnique.mockResolvedValue(null);

      await listener.handleCompanyRegistered({ companyId: 'gone' });

      expect(notifications.notifyUsers).not.toHaveBeenCalled();
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
      expect(notifications.notifyUsers).toHaveBeenCalledWith({
        userIds: ['owner-1'],
        excludeUserId: 'member-1',
        eventType: NotificationEvent.MEMBER_JOIN_REQUESTED,
        message: notificationTemplates.memberJoinRequested('Sam', 'UPL Co'),
        data: { companyId: 'company-1', memberUserId: 'member-1' },
      });
    });

    it('sends nothing when the member no longer exists', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await listener.handleMemberJoinRequested(event);

      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });
  });

  describe('member.approved', () => {
    const event = { memberUserId: 'member-1', approvedByUserId: 'owner-1' };

    it("emails the member with their company's name, excluding the approver", async () => {
      prisma.user.findUnique.mockResolvedValue({
        company: { id: 'company-1', name: 'UPL Co' },
      });

      await listener.handleMemberApproved(event);

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'member-1' },
        // id too: the push deep-links to the company
        select: { company: { select: { id: true, name: true } } },
      });
      expect(notifications.notifyUsers).toHaveBeenCalledWith({
        userIds: ['member-1'],
        excludeUserId: 'owner-1',
        eventType: NotificationEvent.MEMBER_APPROVED,
        message: notificationTemplates.memberApproved('UPL Co'),
        data: { companyId: 'company-1' },
      });
    });

    it('sends nothing when the member is gone or has no company', async () => {
      prisma.user.findUnique.mockResolvedValue({ company: null });
      await listener.handleMemberApproved(event);

      prisma.user.findUnique.mockResolvedValue(null);
      await listener.handleMemberApproved(event);

      expect(notifications.notifyUsers).not.toHaveBeenCalled();
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
      expect(notifications.notifyUsers).toHaveBeenCalledWith({
        userIds: ['manager-1', 'owner-1'],
        excludeUserId: 'manager-1',
        eventType: NotificationEvent.ORDER_CREATED,
        message: notificationTemplates.orderCreated(
          'Corner A',
          'Weekend restock',
          2,
        ),
        data: { cornerId: 'corner-1', orderId: 'order-1' },
      });
    });

    it('sends nothing when the order no longer exists', async () => {
      prisma.order.findFirst.mockResolvedValue(null);

      await listener.handleOrderCreated(event);

      expect(notifications.notifyUsers).not.toHaveBeenCalled();
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

      expect(notifications.notifyUsers).toHaveBeenCalledWith({
        userIds: ['manager-1', 'owner-1'],
        excludeUserId: 'owner-1',
        eventType: NotificationEvent.AUDIT_APPLIED,
        message: notificationTemplates.auditApplied(
          'Corner A',
          'Monthly count',
          3,
        ),
        data: { cornerId: 'corner-1', auditId: 'audit-1' },
      });
    });

    it('sends nothing when the audit no longer exists', async () => {
      prisma.inventoryAudit.findFirst.mockResolvedValue(null);

      await listener.handleAuditApplied(event);

      expect(notifications.notifyUsers).not.toHaveBeenCalled();
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
      const call = notifications.notifyUsers.mock.calls[0][0];
      expect(call).toEqual({
        userIds: ['manager-1', 'owner-1'],
        eventType: NotificationEvent.STOCK_BELOW_TARGET,
        message: notificationTemplates.stockBelowTarget(
          'Corner A',
          'Cola 500ml',
          7,
          10,
        ),
        // the integer placement id travels as a STRING (FCM data rule)
        data: { cornerId: 'corner-1', placementId: '41' },
      });
      expect(call).not.toHaveProperty('excludeUserId');
    });

    it('sends nothing when the placement no longer exists', async () => {
      prisma.companyStoreProduct.findUnique.mockResolvedValue(null);

      await listener.handleStockBelowTarget(event);

      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });
  });

  describe('account.passwordReset', () => {
    it('emails the account owner a "password changed" notice (nobody excluded)', async () => {
      await listener.handleAccountPasswordReset({ userId: 'user-1' });

      const call = notifications.notifyUsers.mock.calls[0][0];
      expect(call).toEqual({
        userIds: ['user-1'],
        eventType: NotificationEvent.ACCOUNT_PASSWORD_RESET,
        message: notificationTemplates.passwordReset(),
      });
      // no ids to deep-link to: the worker still adds eventType for the app
      expect(call).not.toHaveProperty('data');
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
