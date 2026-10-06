import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env.schema';
import { PUSH_SENDER } from './notifications.constants';
import { FakePushSender } from './channels/fake-push.sender';
import { FcmPushSender } from './channels/fcm-push.sender';
import type { PushSender } from './channels/push-sender';

/**
 * The push sender on its own, so both NotificationsModule (sending) and
 * DevicesModule (validating tokens) can use it without importing each other.
 */
@Module({
  providers: [
    FakePushSender,
    {
      // FCM is built only when chosen: it reads the key file on construction.
      provide: PUSH_SENDER,
      inject: [ConfigService, FakePushSender],
      useFactory: (
        config: ConfigService<Env, true>,
        fake: FakePushSender,
      ): PushSender =>
        config.get('PUSH_SENDER', { infer: true }) === 'fcm'
          ? new FcmPushSender(
              // guaranteed by env validation when PUSH_SENDER=fcm
              config.get('FIREBASE_SERVICE_ACCOUNT_PATH', { infer: true })!,
            )
          : fake,
    },
  ],
  exports: [PUSH_SENDER, FakePushSender],
})
export class PushModule {}
