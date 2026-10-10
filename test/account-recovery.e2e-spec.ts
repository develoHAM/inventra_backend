import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { NotificationStatus } from '../src/generated/prisma/enums';
import { PrismaService } from '../src/prisma/prisma.service';
import { NotificationEvent } from '../src/notifications/notification-events';
import { testPhones, verifiedPhoneToken } from './helpers/phone';

// The reset email is delivered asynchronously (queue + worker): allow polling.
jest.setTimeout(30_000);

/**
 * Find my ID and password reset, end to end: OCTOMO verification (fake)
 * → find-id / reset-password → sessions revoked → "password changed" email
 * lands in Mailpit.
 */
describe('Account recovery (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: any;

  const mailpitApi = `http://localhost:${process.env.MAILPIT_UI_PORT ?? 8025}/api/v1`;
  const ownerEmail = 'owner@ar.test';
  const oldPassword = 'password123';
  const newPassword = 'brand-new-password';

  // users.phone is unique across the shared DB: suite 13's own block
  const nextPhone = testPhones(13);
  const ownerPhone = nextPhone(); // digits, e.g. '01013000001'
  const ownerPhoneDashed = `${ownerPhone.slice(0, 3)}-${ownerPhone.slice(3, 7)}-${ownerPhone.slice(7)}`;

  let oldRefreshToken: string;

  const login = (email: string, password: string) =>
    request(http)
      .post('/auth/login')
      .send({ email: email, password: password });
  const findId = (phone: string, token: string) =>
    request(http)
      .post('/auth/find-id')
      .send({ phone: phone, phoneVerificationToken: token });
  const resetPassword = (body: Record<string, unknown>) =>
    request(http)
      .post('/auth/reset-password')
      .send({
        email: ownerEmail,
        phone: ownerPhone,
        newPassword: newPassword,
        ...body,
      });

  // Delivery is asynchronous, so poll instead of asserting once.
  const waitFor = async <T>(
    probe: () => Promise<T | null>,
    timeoutMs = 10_000,
  ): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await probe();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`waitFor timed out after ${timeoutMs}ms`);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    http = app.getHttpServer();

    // an earlier run must not make the Mailpit check pass
    await fetch(
      `${mailpitApi}/search?query=${encodeURIComponent(`to:${ownerEmail}`)}`,
      { method: 'DELETE' },
    );

    // the account to recover: a (pending) owner with a verified phone
    await request(http)
      .post('/auth/register')
      .send({
        companyName: 'AR Co',
        taxId: '660-00-00001',
        ownerName: 'AR Owner',
        credentials: {
          type: 'password',
          email: ownerEmail,
          password: oldPassword,
        },
        ownerPhone: ownerPhone,
        ownerPhoneVerificationToken: await verifiedPhoneToken(app, ownerPhone),
      })
      .expect(201);

    // a logged-in session that the reset must end
    oldRefreshToken = (await login(ownerEmail, oldPassword).expect(201)).body
      .refreshToken;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('find my ID', () => {
    it('a verified phone reveals its account’s email, masked', async () => {
      const token = await verifiedPhoneToken(app, ownerPhone, 'FIND_ID');

      // typed with dashes, as people do
      const response = await findId(ownerPhoneDashed, token).expect(200);
      expect(response.body).toEqual({ email: 'ow***@ar.test' });
    });

    it('the token is single-use', async () => {
      const token = await verifiedPhoneToken(app, ownerPhone, 'FIND_ID');
      await findId(ownerPhone, token).expect(200);

      await findId(ownerPhone, token).expect(400);
    });

    it('a phone with no account gets 404', async () => {
      const strangerPhone = nextPhone();
      const token = await verifiedPhoneToken(app, strangerPhone, 'FIND_ID');

      const response = await findId(strangerPhone, token).expect(404);
      expect(response.body.message).toBe('No account uses this phone');
    });

    it('a RESET_PASSWORD token cannot be used to find the ID', async () => {
      const token = await verifiedPhoneToken(app, ownerPhone, 'RESET_PASSWORD');

      await findId(ownerPhone, token).expect(400);
    });
  });

  describe('password reset', () => {
    it('a FIND_ID token cannot reset the password', async () => {
      const token = await verifiedPhoneToken(app, ownerPhone, 'FIND_ID');

      await resetPassword({ phoneVerificationToken: token }).expect(400);
      await login(ownerEmail, oldPassword).expect(201); // unchanged
    });

    it('the right phone with another email is refused — and the token is spent', async () => {
      const token = await verifiedPhoneToken(app, ownerPhone, 'RESET_PASSWORD');

      const mismatch = await resetPassword({
        email: 'someone-else@ar.test',
        phoneVerificationToken: token,
      }).expect(400);
      expect(mismatch.body.message).toBe(
        'Email and phone do not match an account',
      );
      await login(ownerEmail, oldPassword).expect(201); // unchanged

      // the same token with the right email: already spent
      await resetPassword({ phoneVerificationToken: token }).expect(400);
      await login(ownerEmail, oldPassword).expect(201);
    });

    it('email + verified phone resets the password (204, no body)', async () => {
      const token = await verifiedPhoneToken(app, ownerPhone, 'RESET_PASSWORD');

      const response = await resetPassword({
        phoneVerificationToken: token,
      }).expect(204);
      expect(response.body).toEqual({});
    });

    it('the old password stops working; the new one works', async () => {
      await login(ownerEmail, oldPassword).expect(401);
      await login(ownerEmail, newPassword).expect(201);
    });

    it('every earlier session is logged out (old refresh token → 401)', async () => {
      await request(http)
        .post('/auth/refresh')
        .send({ refreshToken: oldRefreshToken })
        .expect(401);
    });

    it('the owner is emailed "password changed" through the queue', async () => {
      const notification = await waitFor(() =>
        prisma.notification.findFirst({
          where: {
            eventType: NotificationEvent.ACCOUNT_PASSWORD_RESET,
            recipientAddress: ownerEmail,
            status: NotificationStatus.SENT,
          },
        }),
      );
      expect(notification.subject).toBe('[Inventra] 비밀번호가 변경되었습니다');

      const inbox = await waitFor(async () => {
        const response = await fetch(
          `${mailpitApi}/search?query=${encodeURIComponent(`to:${ownerEmail}`)}`,
        );
        const body = (await response.json()) as {
          messages: { Subject: string }[];
        };
        return body.messages.length > 0 ? body : null;
      });
      expect(inbox.messages[0].Subject).toBe(
        '[Inventra] 비밀번호가 변경되었습니다',
      );
    });

    it('exactly one "password changed" email, not one per attempt', async () => {
      const sent = await prisma.notification.count({
        where: {
          eventType: NotificationEvent.ACCOUNT_PASSWORD_RESET,
          recipientAddress: ownerEmail,
        },
      });
      expect(sent).toBe(1); // the refused attempts sent nothing
    });

    it('a too-short new password is rejected by validation (400)', async () => {
      const token = await verifiedPhoneToken(app, ownerPhone, 'RESET_PASSWORD');

      await resetPassword({
        phoneVerificationToken: token,
        newPassword: 'short',
      }).expect(400);
      await login(ownerEmail, newPassword).expect(201); // unchanged
    });
  });
});
