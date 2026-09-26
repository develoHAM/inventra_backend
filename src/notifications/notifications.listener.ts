import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationChannel } from '../generated/prisma/enums';
import { notificationTemplates } from './notification-templates';
import { NotificationsService } from './notifications.service';
import { NotificationEvent } from './notification-events';
import type { CompanyApprovedEvent } from './notification-events';

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
}
