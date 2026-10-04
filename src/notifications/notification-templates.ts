export interface RenderedMessage {
  subject: string;
  body: string;
}

export const notificationTemplates = {
  companyApproved: (companyName: string): RenderedMessage => ({
    subject: `[Inventra] 회사 가입이 승인되었습니다`,
    body: `${companyName} 회사의 가입이 승인되었습니다. 이제 Inventra에 로그인할 수 있습니다.`,
  }),
  companyRegistered: (companyName: string): RenderedMessage => ({
    subject: '[Inventra] 새 회사 가입 승인 요청',
    body: `${companyName} 회사가 가입을 신청했습니다. 관리자 화면에서 승인해 주세요.`,
  }),
  memberJoinRequested: (
    memberName: string,
    companyName: string,
  ): RenderedMessage => ({
    subject: '[Inventra] 새 구성원 가입 요청',
    body: `${memberName}님이 ${companyName}에 가입을 요청했습니다. 역할을 지정해 승인해 주세요.`,
  }),
  memberApproved: (companyName: string): RenderedMessage => ({
    subject: '[Inventra] 가입이 승인되었습니다',
    body: `${companyName}의 구성원으로 승인되었습니다. 이제 Inventra에 로그인할 수 있습니다.`,
  }),
  orderCreated: (
    cornerName: string,
    orderTitle: string,
    itemCount: number,
  ): RenderedMessage => ({
    subject: '[Inventra] 새 발주가 등록되었습니다',
    body: `${cornerName} 코너에 발주 "${orderTitle}"(${itemCount}개 품목)가 등록되었습니다.`,
  }),
  auditApplied: (
    cornerName: string,
    auditTitle: string,
    itemCount: number,
  ): RenderedMessage => ({
    subject: '[Inventra] 재고 실사가 반영되었습니다',
    body: `${cornerName} 코너의 실사 "${auditTitle}"(${itemCount}개 품목)가 재고에 반영되었습니다.`,
  }),
  stockBelowTarget: (
    cornerName: string,
    productName: string,
    availableQuantity: number,
    targetStockQuantity: number,
  ): RenderedMessage => ({
    subject: '[Inventra] 재고 부족 알림',
    body: `${cornerName} 코너의 ${productName} 가용 재고가 ${availableQuantity}개로 목표 수량(${targetStockQuantity}개)보다 적습니다.`,
  }),
  passwordReset: (): RenderedMessage => ({
    subject: '[Inventra] 비밀번호가 변경되었습니다',
    body: '계정의 비밀번호가 변경되었고, 모든 기기에서 로그아웃되었습니다. 본인이 변경하지 않았다면 즉시 비밀번호 찾기로 비밀번호를 다시 설정하고 회사 관리자에게 알려 주세요.',
  }),
};
