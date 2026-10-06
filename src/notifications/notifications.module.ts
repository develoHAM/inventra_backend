import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { NOTIFICATIONS_QUEUE } from './notifications.constants';
import { NotificationsService } from './notifications.service';
import { NotificationsListener } from './notifications.listener';
import { NotificationsProcessor } from './notifications.processor';
import { NotificationsReconciler } from './notifications.reconciler';
import { EmailChannel } from './channels/email.channel';
import { PushModule } from './push.module';
import { DevicesModule } from '../devices/devices.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: NOTIFICATIONS_QUEUE }),
    PushModule,
    DevicesModule,
  ],
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
