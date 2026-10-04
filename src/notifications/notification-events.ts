export const NotificationEvent = {
  COMPANY_APPROVED: 'company.approved',
  COMPANY_REGISTERED: 'company.registered',
  MEMBER_JOIN_REQUESTED: 'member.joinRequested',
  MEMBER_APPROVED: 'member.approved',
  ORDER_CREATED: 'order.created',
  AUDIT_APPLIED: 'audit.applied',
  STOCK_BELOW_TARGET: 'stock.belowTarget',
  ACCOUNT_PASSWORD_RESET: 'account.passwordReset',
} as const;

export interface CompanyApprovedEvent {
  companyId: string;
  ownerUserId: string;
}

export interface CompanyRegisteredEvent {
  companyId: string;
}

export interface MemberJoinRequestedEvent {
  companyId: string;
  memberUserId: string;
}

export interface MemberApprovedEvent {
  memberUserId: string;
  approvedByUserId: string;
}

export interface AccountPasswordResetEvent {
  userId: string;
}

export interface OrderCreatedEvent {
  orderId: string;
  cornerId: string;
  createdByUserId: string;
}

export interface AuditAppliedEvent {
  auditId: string;
  cornerId: string;
  appliedByUserId: string;
}

export interface StockBelowTargetEvent {
  placementId: number;
  availableQuantity: number;
  targetStockQuantity: number;
}
