import { cert, initializeApp } from 'firebase-admin/app';
import {
  FirebaseMessagingError,
  MessagingErrorCode,
  getMessaging,
} from 'firebase-admin/messaging';
import { FcmPushSender } from './fcm-push.sender';
import { DeadDeviceTokenError } from './push-sender';

// Never talk to Firebase in a unit test: replace the SDK's entry points,
// but keep its REAL error classes and codes so we test against what FCM
// actually throws (error.code is prefixed: 'messaging/…').
jest.mock('firebase-admin/app', () => ({
  cert: jest.fn(() => 'service-account-credential'),
  initializeApp: jest.fn(() => ({ name: 'inventra-push' })),
}));
const messaging = { send: jest.fn() };
jest.mock('firebase-admin/messaging', () => ({
  ...jest.requireActual('firebase-admin/messaging'),
  getMessaging: jest.fn(() => messaging),
}));

// A real FCM error, built with the SDK's PUBLIC constructor: it adds the
// 'messaging/' prefix to error.code exactly as errors from send() have it.
const fcmError = (code: MessagingErrorCode) =>
  new FirebaseMessagingError({ code: code, message: `FCM failed: ${code}` });

describe('FcmPushSender', () => {
  let sender: FcmPushSender;

  beforeEach(() => {
    jest.clearAllMocks();
    messaging.send.mockResolvedValue('projects/p/messages/1');
    sender = new FcmPushSender('/secrets/firebase-service-account.json');
  });

  it('initializes its own named Firebase app from the service-account file', () => {
    expect(cert).toHaveBeenCalledWith('/secrets/firebase-service-account.json');
    expect(initializeApp).toHaveBeenCalledWith(
      { credential: 'service-account-credential' },
      'inventra-push',
    );
    expect(getMessaging).toHaveBeenCalledWith({ name: 'inventra-push' });
  });

  it('sends one notification to the device token: subject → title, body → body', async () => {
    await sender.send({
      to: 'phone-token',
      subject: '[Inventra] 가입이 승인되었습니다',
      body: 'NTF Co의 구성원으로 승인되었습니다.',
    });

    expect(messaging.send).toHaveBeenCalledWith({
      token: 'phone-token',
      notification: {
        title: '[Inventra] 가입이 승인되었습니다',
        body: 'NTF Co의 구성원으로 승인되었습니다.',
      },
    });
  });

  it('forwards the deep-link data with the notification', async () => {
    await sender.send({
      to: 'phone-token',
      subject: 'T',
      body: 'B',
      data: { eventType: 'order.created', orderId: 'order-1' },
    });

    expect(messaging.send).toHaveBeenCalledWith({
      token: 'phone-token',
      notification: { title: 'T', body: 'B' },
      data: { eventType: 'order.created', orderId: 'order-1' },
    });
  });

  it('real errors carry the PREFIXED code (why === against MessagingErrorCode would miss)', () => {
    const error = fcmError(
      MessagingErrorCode.REGISTRATION_TOKEN_NOT_REGISTERED,
    );

    expect(error.code).toBe('messaging/registration-token-not-registered');
    expect(error.code).not.toBe(
      MessagingErrorCode.REGISTRATION_TOKEN_NOT_REGISTERED,
    );
  });

  it.each([
    MessagingErrorCode.REGISTRATION_TOKEN_NOT_REGISTERED, // FCM: UNREGISTERED
    MessagingErrorCode.INVALID_REGISTRATION_TOKEN, // FCM: malformed token
  ])(
    '%s → DeadDeviceTokenError: the token will never work again',
    async (code) => {
      messaging.send.mockRejectedValue(fcmError(code));

      const attempt = sender.send({
        to: 'stale-token',
        subject: 'T',
        body: 'B',
      });

      await expect(attempt).rejects.toBeInstanceOf(DeadDeviceTokenError);
      await expect(attempt).rejects.toMatchObject({ token: 'stale-token' });
    },
  );

  it.each([
    MessagingErrorCode.SERVER_UNAVAILABLE,
    MessagingErrorCode.INTERNAL_ERROR,
    MessagingErrorCode.MESSAGE_RATE_EXCEEDED,
    // a bad PAYLOAD is not a dead token: don't delete the device for it
    MessagingErrorCode.INVALID_ARGUMENT,
  ])(
    '%s passes through unchanged: the worker retries / records it',
    async (code) => {
      messaging.send.mockRejectedValue(fcmError(code));

      const attempt = sender.send({
        to: 'phone-token',
        subject: 'T',
        body: 'B',
      });

      await expect(attempt).rejects.toBeInstanceOf(FirebaseMessagingError);
      await expect(attempt).rejects.toMatchObject({
        code: `messaging/${code}`,
      });
    },
  );

  it('a non-Firebase error (e.g. a network failure) passes through too', async () => {
    messaging.send.mockRejectedValue(new Error('socket hang up'));

    await expect(
      sender.send({ to: 'phone-token', subject: 'T', body: 'B' }),
    ).rejects.toThrow('socket hang up');
  });

  describe('isValidToken (dry run: FCM checks the token, delivers nothing)', () => {
    it('asks FCM with dryRun=true and a fixed, valid payload', async () => {
      await sender.isValidToken('phone-token');

      expect(messaging.send).toHaveBeenCalledWith(
        {
          token: 'phone-token',
          notification: { title: 'Inventra', body: 'token check' },
        },
        true,
      );
    });

    it('a token FCM accepts is valid', async () => {
      await expect(sender.isValidToken('phone-token')).resolves.toBe(true);
    });

    it.each([
      // what a malformed token actually returns (seen against real FCM)
      MessagingErrorCode.INVALID_ARGUMENT,
      MessagingErrorCode.INVALID_REGISTRATION_TOKEN,
      MessagingErrorCode.REGISTRATION_TOKEN_NOT_REGISTERED,
    ])(
      '%s means the token is invalid (our dry-run payload is fixed and valid)',
      async (code) => {
        messaging.send.mockRejectedValue(fcmError(code));

        await expect(sender.isValidToken('garbage')).resolves.toBe(false);
      },
    );

    it.each([
      MessagingErrorCode.SERVER_UNAVAILABLE,
      MessagingErrorCode.INTERNAL_ERROR,
      MessagingErrorCode.AUTHENTICATION_ERROR,
    ])('%s says nothing about the token: rethrown', async (code) => {
      messaging.send.mockRejectedValue(fcmError(code));

      await expect(sender.isValidToken('phone-token')).rejects.toMatchObject({
        code: `messaging/${code}`,
      });
    });
  });
});
