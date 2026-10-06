import { NotificationSender } from './notification-channel';

/** A push sender also knows whether a device token is usable. */
export interface PushSender extends NotificationSender {
  /** true: the provider accepts this token. false: it never will. Throws if the provider can't answer. */
  isValidToken(token: string): Promise<boolean>;
}

/**
 * FCM said this device token will never work again (app uninstalled, token
 * rotated or malformed). Not worth a retry: the worker deletes the device.
 */
export class DeadDeviceTokenError extends Error {
  constructor(public readonly token: string) {
    super('device token unregistered');
    this.name = 'DeadDeviceTokenError';
  }
}
