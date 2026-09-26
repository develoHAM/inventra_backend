export const NotificationEvent = {
  COMPANY_APPROVED: 'company.approved',
} as const;

export interface CompanyApprovedEvent {
  companyId: string;
  ownerUserId: string;
}
