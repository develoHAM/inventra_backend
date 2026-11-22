import type { MemberRoleCode } from '../profiles/member-rules';

export const NotificationEvent = {
  COMPANY_APPROVED: 'company.approved',
  COMPANY_REGISTERED: 'company.registered',
  MEMBER_JOIN_REQUESTED: 'member.joinRequested',
  MEMBER_APPROVED: 'member.approved',
  MEMBER_MOVED: 'member.moved',
  MEMBER_ROLE_CHANGED: 'member.roleChanged',
  MEMBER_LEFT: 'member.left',
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

/** Someone's branches changed: one event per assignment started or ended. */
export interface MemberMovedEvent {
  memberProfileId: string;
  changedByProfileId: string | null; // null = changed by the system
  cornerId: string; // the branch they were added to, or that they left
  change: 'ADDED' | 'REMOVED' | 'BRANCH_DELETED';
}

export interface MemberRoleChangedEvent {
  memberProfileId: string;
  changedByProfileId: string | null; // null = changed by the system
  toRoleCode: MemberRoleCode;
}

/**
 * Someone is out of the company: they left, were removed, or deleted their
 * account. A snapshot taken in the transaction: after the commit their
 * assignments are ended rows, so the event carries which ones just ended.
 */
export interface MemberLeftEvent {
  companyId: string;
  memberProfileId: string;
  memberName: string;
  cornerIds: string[]; // the branches whose assignments just ended
  reason: 'LEFT_COMPANY' | 'REMOVED' | 'ACCOUNT_DELETED';
  changedByProfileId: string; // the leaver, or the remover
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
