import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { NOTIFICATIONS_QUEUE } from './notifications.constants';
import { NotificationsService } from './notifications.service';
import { NotificationsListener } from './notifications.listener';
import { NotificationsProcessor } from './notifications.processor';
import { EmailChannel } from './channels/email.channel';
import { NotificationsReconciler } from './notifications.reconciler';

@Module({
  imports: [BullModule.registerQueue({ name: NOTIFICATIONS_QUEUE })],
  providers: [
    NotificationsService,
    NotificationsListener,
    NotificationsProcessor,
    NotificationsReconciler,
    EmailChannel,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
