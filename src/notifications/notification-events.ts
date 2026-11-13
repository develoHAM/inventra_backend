import type { MemberRoleCode } from '../profiles/member-rules';

export const NotificationEvent = {
  COMPANY_APPROVED: 'company.approved',
  COMPANY_REGISTERED: 'company.registered',
  MEMBER_JOIN_REQUESTED: 'member.joinRequested',
  MEMBER_APPROVED: 'member.approved',
  MEMBER_MOVED: 'member.moved',
  MEMBER_ROLE_CHANGED: 'member.roleChanged',
  ORDER_CREATED: 'order.created',
  AUDIT_APPLIED: 'audit.applied',
  STOCK_BELOW_TARGET: 'stock.belowTarget',
  ACCOUNT_PASSWORD_RESET: 'account.passwordReset',
} as const;

export interface CompanyApprovedEvent {
  companyId: string;
  ownerProfileId: string;
}

export interface CompanyRegisteredEvent {
  companyId: string;
}

export interface MemberJoinRequestedEvent {
  companyId: string;
  memberProfileId: string;
}

export interface MemberApprovedEvent {
  memberProfileId: string;
  approvedByProfileId: string;
}

export interface MemberMovedEvent {
  memberProfileId: string;
  changedByProfileId: string | null; // null = moved by the system
  fromCornerId: string | null;
  toCornerId: string | null; // null = no branch now
  reason: 'MOVED' | 'BRANCH_DELETED';
}

export interface MemberRoleChangedEvent {
  memberProfileId: string;
  changedByProfileId: string | null; // null = changed by the system
  toRoleCode: MemberRoleCode;
}

/** About the sign-in itself, not a company: notified to the account. */
export interface AccountPasswordResetEvent {
  accountId: string;
}

export interface OrderCreatedEvent {
  orderId: string;
  cornerId: string;
  createdByProfileId: string;
}

export interface AuditAppliedEvent {
  auditId: string;
  cornerId: string;
  appliedByProfileId: string;
}

export interface StockBelowTargetEvent {
  placementId: number;
  availableQuantity: number;
  targetStockQuantity: number;
}
