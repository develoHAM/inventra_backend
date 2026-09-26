export interface RenderedMessage {
  subject: string;
  body: string;
}

export const notificationTemplates = {
  companyApproved: (companyName: string): RenderedMessage => ({
    subject: `[Inventra] 회사 가입이 승인되었습니다`,
    body: `${companyName} 회사의 가입이 승인되었습니다. 이제 Inventra에 로그인할 수 있습니다.`,
  }),
};
