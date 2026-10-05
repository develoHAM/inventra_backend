import { cert, initializeApp } from 'firebase-admin/app';
import {
  FirebaseMessagingError,
  Messaging,
  MessagingErrorCode,
  getMessaging,
} from 'firebase-admin/messaging';
import { NotificationSender, OutgoingMessage } from './notification-channel';
import { DeadDeviceTokenError } from './push-sender';

/**
 * FCM answers meaning "this token will never work again". Compared with
 * hasCode(), not ===: at runtime error.code is prefixed ('messaging/…')
 * while the enum values are not.
 */
const DEAD_TOKEN_CODES = [
  MessagingErrorCode.REGISTRATION_TOKEN_NOT_REGISTERED,
  MessagingErrorCode.INVALID_REGISTRATION_TOKEN,
];

/**
 * Real push through Firebase Cloud Messaging (Android, iOS, web).
 * Constructed by the PUSH_SENDER factory only when PUSH_SENDER=fcm, because
 * it reads the service-account key at construction.
 */
export class FcmPushSender implements NotificationSender {
  private readonly messaging: Messaging;

  constructor(serviceAccountPath: string) {
    const app = initializeApp(
      { credential: cert(serviceAccountPath) },
      'inventra-push',
    );
    this.messaging = getMessaging(app);
  }

  async send(message: OutgoingMessage): Promise<void> {
    try {
      await this.messaging.send({
        token: message.to,
        notification: { title: message.subject, body: message.body },
      });
    } catch (error) {
      if (
        error instanceof FirebaseMessagingError &&
        DEAD_TOKEN_CODES.some((code) => error.hasCode(code))
      ) {
        throw new DeadDeviceTokenError(message.to);
      }
      throw error; // temporary (or not ours to judge): the worker retries
    }
  }
}
