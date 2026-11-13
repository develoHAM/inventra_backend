import { NotificationsListener } from './notifications.listener';
import { NotificationChannel } from '../generated/prisma/enums';
import { NotificationEvent } from './notification-events';
import { notificationTemplates } from './notification-templates';

describe('NotificationsListener', () => {
  let listener: NotificationsListener;
  let prisma: {
    company: { findUnique: jest.Mock };
    profile: { findUnique: jest.Mock };
    order: { findFirst: jest.Mock };
    inventoryAudit: { findFirst: jest.Mock };
    companyStoreProduct: { findUnique: jest.Mock };
    companyStore: { findUnique: jest.Mock };
  };
  let notifications: {
    findProfileEmail: jest.Mock;
    dispatch: jest.Mock;
    notifyProfiles: jest.Mock;
    notifyAccount: jest.Mock;
    findPlatformAdminIds: jest.Mock;
    findCompanyOwnerIds: jest.Mock;
    findCornerRecipientIds: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      company: { findUnique: jest.fn().mockResolvedValue({ name: 'UPL Co' }) },
      profile: { findUnique: jest.fn() },
      order: { findFirst: jest.fn() },
      inventoryAudit: { findFirst: jest.fn() },
      companyStoreProduct: { findUnique: jest.fn() },
      companyStore: { findUnique: jest.fn() },
    };
    notifications = {
      findProfileEmail: jest.fn().mockResolvedValue('owner@example.com'),
      dispatch: jest.fn().mockResolvedValue(undefined),
      notifyProfiles: jest.fn().mockResolvedValue(undefined),
      notifyAccount: jest.fn().mockResolvedValue(undefined),
      findPlatformAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      findCompanyOwnerIds: jest.fn().mockResolvedValue(['owner-1']),
      findCornerRecipientIds: jest
        .fn()
        .mockResolvedValue(['manager-1', 'owner-1']),
    };
    listener = new NotificationsListener(prisma as any, notifications as any);
  });

  describe('company.approved', () => {
    const event = { companyId: 'company-1', ownerProfileId: 'owner-1' };

    it('notifies the owner with the companyApproved template (email + push via notifyProfiles)', async () => {
      await listener.handleCompanyApproved(event);

      expect(prisma.company.findUnique).toHaveBeenCalledWith({
        where: { id: 'company-1' },
        select: { name: true },
      });
      const call = notifications.notifyProfiles.mock.calls[0][0];
      expect(call).toEqual({
        profileIds: ['owner-1'],
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

      expect(notifications.notifyProfiles).not.toHaveBeenCalled();
    });
  });

  describe('company.registered', () => {
    it('emails every platform admin', async () => {
      await listener.handleCompanyRegistered({ companyId: 'company-1' });

      expect(notifications.notifyProfiles).toHaveBeenCalledWith({
        profileIds: ['admin-1'],
        eventType: NotificationEvent.COMPANY_REGISTERED,
        message: notificationTemplates.companyRegistered('UPL Co'),
        data: { companyId: 'company-1' },
      });
    });

    it('sends nothing when the company no longer exists', async () => {
      prisma.company.findUnique.mockResolvedValue(null);

      await listener.handleCompanyRegistered({ companyId: 'gone' });

      expect(notifications.notifyProfiles).not.toHaveBeenCalled();
    });
  });

  describe('member.joinRequested', () => {
    const event = { companyId: 'company-1', memberProfileId: 'member-1' };

    it('emails the company owner(s), naming the member, excluding the member', async () => {
      prisma.profile.findUnique.mockResolvedValue({ name: 'Sam' });

      await listener.handleMemberJoinRequested(event);

      expect(notifications.findCompanyOwnerIds).toHaveBeenCalledWith(
        'company-1',
      );
      expect(notifications.notifyProfiles).toHaveBeenCalledWith({
        profileIds: ['owner-1'],
        excludeProfileId: 'member-1',
        eventType: NotificationEvent.MEMBER_JOIN_REQUESTED,
        message: notificationTemplates.memberJoinRequested('Sam', 'UPL Co'),
        data: { companyId: 'company-1', memberProfileId: 'member-1' },
      });
    });

    it('sends nothing when the member no longer exists', async () => {
      prisma.profile.findUnique.mockResolvedValue(null);

      await listener.handleMemberJoinRequested(event);

      expect(notifications.notifyProfiles).not.toHaveBeenCalled();
    });
  });

  describe('member.approved', () => {
    const event = {
      memberProfileId: 'member-1',
      approvedByProfileId: 'owner-1',
    };

    it("emails the member with their company's name, excluding the approver", async () => {
      prisma.profile.findUnique.mockResolvedValue({
        company: { id: 'company-1', name: 'UPL Co' },
      });

      await listener.handleMemberApproved(event);

      expect(prisma.profile.findUnique).toHaveBeenCalledWith({
        where: { id: 'member-1' },
        // id too: the push deep-links to the company
        select: { company: { select: { id: true, name: true } } },
      });
      expect(notifications.notifyProfiles).toHaveBeenCalledWith({
        profileIds: ['member-1'],
        excludeProfileId: 'owner-1',
        eventType: NotificationEvent.MEMBER_APPROVED,
        message: notificationTemplates.memberApproved('UPL Co'),
        data: { companyId: 'company-1' },
      });
    });

    it('sends nothing when the member is gone or has no company', async () => {
      prisma.profile.findUnique.mockResolvedValue({ company: null });
      await listener.handleMemberApproved(event);

      prisma.profile.findUnique.mockResolvedValue(null);
      await listener.handleMemberApproved(event);

      expect(notifications.notifyProfiles).not.toHaveBeenCalled();
    });
  });

  describe('order.created', () => {
    const event = {
      orderId: 'order-1',
      cornerId: 'corner-1',
      createdByProfileId: 'manager-1',
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
      expect(notifications.notifyProfiles).toHaveBeenCalledWith({
        profileIds: ['manager-1', 'owner-1'],
        excludeProfileId: 'manager-1',
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

      expect(notifications.notifyProfiles).not.toHaveBeenCalled();
    });
  });

  describe('audit.applied', () => {
    const event = {
      auditId: 'audit-1',
      cornerId: 'corner-1',
      appliedByProfileId: 'owner-1',
    };

    it('emails the corner recipients minus the applier', async () => {
      prisma.inventoryAudit.findFirst.mockResolvedValue({
        title: 'Monthly count',
        companyStore: { name: 'Corner A' },
        _count: { inventoryAuditItems: 3 },
      });

      await listener.handleAuditApplied(event);

      expect(notifications.notifyProfiles).toHaveBeenCalledWith({
        profileIds: ['manager-1', 'owner-1'],
        excludeProfileId: 'owner-1',
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

      expect(notifications.notifyProfiles).not.toHaveBeenCalled();
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
      const call = notifications.notifyProfiles.mock.calls[0][0];
      expect(call).toEqual({
        profileIds: ['manager-1', 'owner-1'],
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

      expect(notifications.notifyProfiles).not.toHaveBeenCalled();
    });
  });

  describe('account.passwordReset', () => {
    it('notifies the ACCOUNT (its sign-in), not each company profile: a "password changed" notice', async () => {
      await listener.handleAccountPasswordReset({ accountId: 'account-1' });

      expect(notifications.notifyAccount).toHaveBeenCalledWith({
        accountId: 'account-1',
        eventType: NotificationEvent.ACCOUNT_PASSWORD_RESET,
        message: notificationTemplates.passwordReset(),
      });
      expect(notifications.notifyProfiles).not.toHaveBeenCalled();
    });

    it('needs no database lookup (the template has no variables)', async () => {
      await listener.handleAccountPasswordReset({ accountId: 'account-1' });

      expect(prisma.profile.findUnique).not.toHaveBeenCalled();
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

  describe('member.moved', () => {
    const event = {
      memberProfileId: 'member-1',
      changedByProfileId: 'owner-1',
      fromCornerId: 'corner-a',
      toCornerId: 'corner-b',
      reason: 'MOVED' as const,
    };

    beforeEach(() => {
      prisma.profile.findUnique.mockResolvedValue({
        company: { id: 'company-1', name: 'UPL Co' },
      });
      prisma.companyStore.findUnique.mockResolvedValue({ name: 'Branch B' });
    });

    it('tells the member their new branch, excluding whoever moved them', async () => {
      await listener.handleMemberMoved(event);

      expect(prisma.companyStore.findUnique).toHaveBeenCalledWith({
        where: { id: 'corner-b' },
        select: { name: true },
      });
      expect(notifications.notifyProfiles).toHaveBeenCalledWith({
        profileIds: ['member-1'],
        excludeProfileId: 'owner-1',
        eventType: NotificationEvent.MEMBER_MOVED,
        message: notificationTemplates.memberMoved('UPL Co', 'Branch B'),
        data: { companyId: 'company-1', cornerId: 'corner-b' },
      });
    });

    it('says they have no branch when moved off it (no cornerId in the push)', async () => {
      await listener.handleMemberMoved({ ...event, toCornerId: null });

      expect(prisma.companyStore.findUnique).not.toHaveBeenCalled();
      expect(notifications.notifyProfiles).toHaveBeenCalledWith(
        expect.objectContaining({
          message: notificationTemplates.memberMoved('UPL Co', null),
          data: { companyId: 'company-1' },
        }),
      );
    });

    it('sends nothing when the member is gone or has no company', async () => {
      prisma.profile.findUnique.mockResolvedValue(null);

      await listener.handleMemberMoved(event);

      expect(notifications.notifyProfiles).not.toHaveBeenCalled();
    });
  });

  describe('member.roleChanged', () => {
    const event = {
      memberProfileId: 'member-1',
      changedByProfileId: 'owner-1',
      toRoleCode: 'MANAGER' as const,
    };

    it('tells the member their new role, excluding whoever changed it', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        company: { id: 'company-1', name: 'UPL Co' },
      });

      await listener.handleMemberRoleChanged(event);

      expect(prisma.profile.findUnique).toHaveBeenCalledWith({
        where: { id: 'member-1' },
        select: { company: { select: { id: true, name: true } } },
      });
      expect(notifications.notifyProfiles).toHaveBeenCalledWith({
        profileIds: ['member-1'],
        excludeProfileId: 'owner-1',
        eventType: NotificationEvent.MEMBER_ROLE_CHANGED,
        message: notificationTemplates.memberRoleChanged('UPL Co', 'MANAGER'),
        data: { companyId: 'company-1' },
      });
    });

    it('sends nothing when the member is gone or has no company', async () => {
      prisma.profile.findUnique.mockResolvedValue(null);

      await listener.handleMemberRoleChanged(event);

      expect(notifications.notifyProfiles).not.toHaveBeenCalled();
    });
  });

  describe('memberRoleChanged template', () => {
    it.each([
      ['OWNER', '대표'],
      ['MANAGER', '매니저'],
      ['STAFF', '직원'],
    ] as const)('names the company and %s as %s', (roleCode, label) => {
      const message = notificationTemplates.memberRoleChanged(
        'UPL Co',
        roleCode,
      );
      expect(message.body).toContain('UPL Co');
      expect(message.body).toContain(label);
      expect(message.body).not.toContain(roleCode);
    });
  });

  describe('member.moved because the branch was deleted', () => {
    const event = {
      memberProfileId: 'member-1',
      changedByProfileId: 'owner-1',
      fromCornerId: 'corner-a',
      toCornerId: null,
      reason: 'BRANCH_DELETED' as const,
    };

    beforeEach(() => {
      prisma.profile.findUnique.mockResolvedValue({
        company: { id: 'company-1', name: 'UPL Co' },
      });
    });

    it('names the closed branch, read even though it is soft-deleted', async () => {
      prisma.companyStore.findUnique.mockResolvedValue({ name: 'Branch A' });

      await listener.handleMemberMoved(event);

      // by id only: no deletedAt filter, the row is deleted by now
      expect(prisma.companyStore.findUnique).toHaveBeenCalledWith({
        where: { id: 'corner-a' },
        select: { name: true },
      });
      expect(notifications.notifyProfiles).toHaveBeenCalledWith({
        profileIds: ['member-1'],
        excludeProfileId: 'owner-1',
        eventType: NotificationEvent.MEMBER_MOVED,
        message: notificationTemplates.memberBranchClosed('UPL Co', 'Branch A'),
        data: { companyId: 'company-1' },
      });
    });

    it('still tells them they have no branch if the branch row cannot be read', async () => {
      prisma.companyStore.findUnique.mockResolvedValue(null);

      await listener.handleMemberMoved(event);

      expect(notifications.notifyProfiles).toHaveBeenCalledWith(
        expect.objectContaining({
          message: notificationTemplates.memberMoved('UPL Co', null),
        }),
      );
    });
  });

  describe('memberBranchClosed template', () => {
    it('names the company and the closed branch', () => {
      const message = notificationTemplates.memberBranchClosed(
        'UPL Co',
        'Branch A',
      );
      expect(message.body).toContain('UPL Co');
      expect(message.body).toContain('Branch A');
    });
  });

  describe('memberMoved template', () => {
    it('names the company and the new branch, or says there is none', () => {
      const moved = notificationTemplates.memberMoved('UPL Co', 'Branch B');
      expect(moved.body).toContain('UPL Co');
      expect(moved.body).toContain('Branch B');

      const released = notificationTemplates.memberMoved('UPL Co', null);
      expect(released.body).toContain('UPL Co');
      expect(released.body).not.toContain('null');
    });
  });
});
