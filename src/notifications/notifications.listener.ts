import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationChannel } from '../generated/prisma/enums';
import { notificationTemplates } from './notification-templates';
import { NotificationsService } from './notifications.service';
import { NotificationEvent } from './notification-events';
import type {
  AuditAppliedEvent,
  CompanyApprovedEvent,
  CompanyRegisteredEvent,
  MemberApprovedEvent,
  MemberJoinRequestedEvent,
  OrderCreatedEvent,
  StockBelowTargetEvent,
  AccountPasswordResetEvent,
} from './notification-events';
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
    const email = await this.notifications.findUserEmail(event.ownerUserId);
    if (!company || !email) return;

    const message = notificationTemplates.companyApproved(company.name);
    await this.notifications.dispatch({
      eventType: NotificationEvent.COMPANY_APPROVED,
      channel: NotificationChannel.EMAIL,
      recipientUserId: event.ownerUserId,
      recipientAddress: email,
      subject: message.subject,
      body: message.body,
    });
  }

  @OnEvent(NotificationEvent.COMPANY_REGISTERED)
  async handleCompanyRegistered(event: CompanyRegisteredEvent): Promise<void> {
    const company = await this.prisma.company.findUnique({
      where: { id: event.companyId },
      select: { name: true },
    });
    if (!company) return;
    await this.notifications.emailUsers({
      userIds: await this.notifications.findPlatformAdminIds(),
      eventType: NotificationEvent.COMPANY_REGISTERED,
      message: notificationTemplates.companyRegistered(company.name),
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
      this.prisma.user.findUnique({
        where: { id: event.memberUserId },
        select: { name: true },
      }),
    ]);
    if (!company || !member) return;
    await this.notifications.emailUsers({
      userIds: await this.notifications.findCompanyOwnerIds(event.companyId),
      excludeUserId: event.memberUserId,
      eventType: NotificationEvent.MEMBER_JOIN_REQUESTED,
      message: notificationTemplates.memberJoinRequested(
        member.name,
        company.name,
      ),
    });
  }

  @OnEvent(NotificationEvent.MEMBER_APPROVED)
  async handleMemberApproved(event: MemberApprovedEvent): Promise<void> {
    const member = await this.prisma.user.findUnique({
      where: { id: event.memberUserId },
      select: { company: { select: { name: true } } },
    });
    if (!member?.company) return;
    await this.notifications.emailUsers({
      userIds: [event.memberUserId],
      excludeUserId: event.approvedByUserId,
      eventType: NotificationEvent.MEMBER_APPROVED,
      message: notificationTemplates.memberApproved(member.company.name),
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
    if (!order) return;
    await this.notifications.emailUsers({
      userIds: await this.notifications.findCornerRecipientIds(event.cornerId),
      excludeUserId: event.createdByUserId,
      eventType: NotificationEvent.ORDER_CREATED,
      message: notificationTemplates.orderCreated(
        order.companyStore.name,
        order.title,
        order._count.orderItems,
      ),
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
    if (!audit) return;
    await this.notifications.emailUsers({
      userIds: await this.notifications.findCornerRecipientIds(event.cornerId),
      excludeUserId: event.appliedByUserId,
      eventType: NotificationEvent.AUDIT_APPLIED,
      message: notificationTemplates.auditApplied(
        audit.companyStore.name,
        audit.title,
        audit._count.inventoryAuditItems,
      ),
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
    if (!placement) return;
    // A state warning, not an action receipt: nobody is excluded.
    await this.notifications.emailUsers({
      userIds: await this.notifications.findCornerRecipientIds(
        placement.companyStoreId,
      ),
      eventType: NotificationEvent.STOCK_BELOW_TARGET,
      message: notificationTemplates.stockBelowTarget(
        placement.companyStore.name,
        placement.product.name,
        event.availableQuantity,
        event.targetStockQuantity,
      ),
    });
  }

  @OnEvent(NotificationEvent.ACCOUNT_PASSWORD_RESET)
  async handleAccountPasswordReset(
    event: AccountPasswordResetEvent,
  ): Promise<void> {
    // The actor IS the recipient — no exclusion. No lookup needed: the
    // template has no variables and emailUsers resolves the address.
    await this.notifications.emailUsers({
      userIds: [event.userId],
      eventType: NotificationEvent.ACCOUNT_PASSWORD_RESET,
      message: notificationTemplates.passwordReset(),
    });
  }
}
