import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { notificationTemplates } from './notification-templates';
import type { RenderedMessage } from './notification-templates';
import { NotificationsService } from './notifications.service';
import { NotificationEvent } from './notification-events';
import type {
  AuditAppliedEvent,
  CompanyApprovedEvent,
  CompanyRegisteredEvent,
  MemberApprovedEvent,
  MemberJoinRequestedEvent,
  MemberMovedEvent,
  MemberRoleChangedEvent,
  OrderCreatedEvent,
  StockBelowTargetEvent,
  AccountPasswordResetEvent,
} from './notification-events';

/**
 * The message for each kind of branch change. A Record over the union: a
 * new kind of change won't compile until it has a message.
 */
const BRANCH_TEMPLATES: Record<
  MemberMovedEvent['change'],
  (companyName: string, cornerName: string) => RenderedMessage
> = {
  ADDED: notificationTemplates.memberBranchAdded,
  REMOVED: notificationTemplates.memberBranchRemoved,
  BRANCH_DELETED: notificationTemplates.memberBranchClosed,
};

@Injectable()
export class NotificationsListener {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent(NotificationEvent.COMPANY_APPROVED)
  async handleCompanyApproved(event: CompanyApprovedEvent): Promise<void> {
    const company = await this.prisma.company.findUnique({
      where: { id: event.companyId },
      select: { name: true },
    });
    if (!company) {
      return;
    }

    // Approved by the platform admin, so there is no actor to exclude.
    await this.notifications.notifyProfiles({
      profileIds: [event.ownerProfileId],
      eventType: NotificationEvent.COMPANY_APPROVED,
      message: notificationTemplates.companyApproved(company.name),
      data: { companyId: event.companyId },
    });
  }

  @OnEvent(NotificationEvent.COMPANY_REGISTERED)
  async handleCompanyRegistered(event: CompanyRegisteredEvent): Promise<void> {
    const company = await this.prisma.company.findUnique({
      where: { id: event.companyId },
      select: { name: true },
    });
    if (!company) {
      return;
    }
    await this.notifications.notifyProfiles({
      profileIds: await this.notifications.findPlatformAdminIds(),
      eventType: NotificationEvent.COMPANY_REGISTERED,
      message: notificationTemplates.companyRegistered(company.name),
      data: { companyId: event.companyId },
    });
  }

  @OnEvent(NotificationEvent.MEMBER_JOIN_REQUESTED)
  async handleMemberJoinRequested(
    event: MemberJoinRequestedEvent,
  ): Promise<void> {
    const [company, member] = await Promise.all([
      this.prisma.company.findUnique({
        where: { id: event.companyId },
        select: { name: true },
      }),
      this.prisma.profile.findUnique({
        where: { id: event.memberProfileId },
        select: { name: true },
      }),
    ]);
    if (!company || !member) {
      return;
    }
    await this.notifications.notifyProfiles({
      profileIds: await this.notifications.findCompanyOwnerIds(event.companyId),
      excludeProfileId: event.memberProfileId,
      eventType: NotificationEvent.MEMBER_JOIN_REQUESTED,
      message: notificationTemplates.memberJoinRequested(
        member.name,
        company.name,
      ),
      data: {
        companyId: event.companyId,
        memberProfileId: event.memberProfileId,
      },
    });
  }

  @OnEvent(NotificationEvent.MEMBER_APPROVED)
  async handleMemberApproved(event: MemberApprovedEvent): Promise<void> {
    const member = await this.prisma.profile.findUnique({
      where: { id: event.memberProfileId },
      select: { company: { select: { id: true, name: true } } },
    });
    if (!member?.company) {
      return;
    }
    await this.notifications.notifyProfiles({
      profileIds: [event.memberProfileId],
      excludeProfileId: event.approvedByProfileId,
      eventType: NotificationEvent.MEMBER_APPROVED,
      message: notificationTemplates.memberApproved(member.company.name),
      data: { companyId: member.company.id },
    });
  }

  @OnEvent(NotificationEvent.MEMBER_MOVED)
  async handleMemberMoved(event: MemberMovedEvent): Promise<void> {
    const member = await this.prisma.profile.findUnique({
      where: { id: event.memberProfileId },
      select: { company: { select: { id: true, name: true } } },
    });
    if (!member?.company) {
      return;
    }
    // By id only, with no deletedAt filter: a deleted branch is still named.
    const corner = await this.prisma.companyStore.findUnique({
      where: { id: event.cornerId },
      select: { name: true },
    });
    if (!corner) {
      return;
    }

    await this.notifications.notifyProfiles({
      profileIds: [event.memberProfileId],
      excludeProfileId: event.changedByProfileId ?? undefined,
      eventType: NotificationEvent.MEMBER_MOVED,
      message: BRANCH_TEMPLATES[event.change](member.company.name, corner.name),
      // Only a branch they now work in is worth opening from the push.
      data:
        event.change === 'ADDED'
          ? { companyId: member.company.id, cornerId: event.cornerId }
          : { companyId: member.company.id },
    });
  }

  @OnEvent(NotificationEvent.MEMBER_ROLE_CHANGED)
  async handleMemberRoleChanged(event: MemberRoleChangedEvent): Promise<void> {
    const member = await this.prisma.profile.findUnique({
      where: { id: event.memberProfileId },
      select: { company: { select: { id: true, name: true } } },
    });
    if (!member?.company) {
      return;
    }
    await this.notifications.notifyProfiles({
      profileIds: [event.memberProfileId],
      excludeProfileId: event.changedByProfileId ?? undefined,
      eventType: NotificationEvent.MEMBER_ROLE_CHANGED,
      message: notificationTemplates.memberRoleChanged(
        member.company.name,
        event.toRoleCode,
      ),
      data: { companyId: member.company.id },
    });
  }

  @OnEvent(NotificationEvent.ORDER_CREATED)
  async handleOrderCreated(event: OrderCreatedEvent): Promise<void> {
    const order = await this.prisma.order.findFirst({
      where: { id: event.orderId, companyStoreId: event.cornerId },
      select: {
        title: true,
        companyStore: { select: { name: true } },
        _count: { select: { orderItems: true } },
      },
    });
    if (!order) {
      return;
    }
    await this.notifications.notifyProfiles({
      profileIds: await this.notifications.findCornerRecipientIds(
        event.cornerId,
      ),
      excludeProfileId: event.createdByProfileId,
      eventType: NotificationEvent.ORDER_CREATED,
      message: notificationTemplates.orderCreated(
        order.companyStore.name,
        order.title,
        order._count.orderItems,
      ),
      data: { cornerId: event.cornerId, orderId: event.orderId },
    });
  }

  @OnEvent(NotificationEvent.AUDIT_APPLIED)
  async handleAuditApplied(event: AuditAppliedEvent): Promise<void> {
    const audit = await this.prisma.inventoryAudit.findFirst({
      where: { id: event.auditId, companyStoreId: event.cornerId },
      select: {
        title: true,
        companyStore: { select: { name: true } },
        _count: { select: { inventoryAuditItems: true } },
      },
    });
    if (!audit) {
      return;
    }
    await this.notifications.notifyProfiles({
      profileIds: await this.notifications.findCornerRecipientIds(
        event.cornerId,
      ),
      excludeProfileId: event.appliedByProfileId,
      eventType: NotificationEvent.AUDIT_APPLIED,
      message: notificationTemplates.auditApplied(
        audit.companyStore.name,
        audit.title,
        audit._count.inventoryAuditItems,
      ),
      data: { cornerId: event.cornerId, auditId: event.auditId },
    });
  }

  @OnEvent(NotificationEvent.STOCK_BELOW_TARGET)
  async handleStockBelowTarget(event: StockBelowTargetEvent): Promise<void> {
    const placement = await this.prisma.companyStoreProduct.findUnique({
      where: { id: event.placementId },
      select: {
        companyStoreId: true,
        companyStore: { select: { name: true } },
        product: { select: { name: true } },
      },
    });
    if (!placement) {
      return;
    }
    // A state warning, not an action receipt: nobody is excluded.
    await this.notifications.notifyProfiles({
      profileIds: await this.notifications.findCornerRecipientIds(
        placement.companyStoreId,
      ),
      eventType: NotificationEvent.STOCK_BELOW_TARGET,
      message: notificationTemplates.stockBelowTarget(
        placement.companyStore.name,
        placement.product.name,
        event.availableQuantity,
        event.targetStockQuantity,
      ),
      // FCM data values must be strings; placement ids are integers
      data: {
        cornerId: placement.companyStoreId,
        placementId: String(event.placementId),
      },
    });
  }

  @OnEvent(NotificationEvent.ACCOUNT_PASSWORD_RESET)
  async handleAccountPasswordReset(
    event: AccountPasswordResetEvent,
  ): Promise<void> {
    // About the sign-in itself, not a company: the account is notified once
    // (its password-login email, each device), not each company profile.
    // The actor IS the recipient, so nobody is excluded.
    await this.notifications.notifyAccount({
      accountId: event.accountId,
      eventType: NotificationEvent.ACCOUNT_PASSWORD_RESET,
      message: notificationTemplates.passwordReset(),
    });
  }
}
