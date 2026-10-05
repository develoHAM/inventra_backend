import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env.schema';
import { NOTIFICATIONS_QUEUE, PUSH_SENDER } from './notifications.constants';
import { NotificationsService } from './notifications.service';
import { NotificationsListener } from './notifications.listener';
import { NotificationsProcessor } from './notifications.processor';
import { NotificationsReconciler } from './notifications.reconciler';
import { EmailChannel } from './channels/email.channel';
import { FakePushSender } from './channels/fake-push.sender';
import { FcmPushSender } from './channels/fcm-push.sender';

@Module({
  imports: [BullModule.registerQueue({ name: NOTIFICATIONS_QUEUE })],
  providers: [
    NotificationsService,
    NotificationsListener,
    NotificationsProcessor,
    NotificationsReconciler,
    EmailChannel,
    FakePushSender,
    {
      // FCM is built only when chosen: it reads the key file on construction.
      provide: PUSH_SENDER,
      inject: [ConfigService, FakePushSender],
      useFactory: (config: ConfigService<Env, true>, fake: FakePushSender) =>
        config.get('PUSH_SENDER', { infer: true }) === 'fcm'
          ? new FcmPushSender(
              // guaranteed by env validation when PUSH_SENDER=fcm
              config.get('FIREBASE_SERVICE_ACCOUNT_PATH', { infer: true })!,
            )
          : fake,
    },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
