import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import {
  NotificationChannel,
  NotificationStatus,
} from '../src/generated/prisma/enums';
import { PrismaService } from '../src/prisma/prisma.service';
import { NotificationEvent } from '../src/notifications/notification-events';
import { notificationTemplates } from '../src/notifications/notification-templates';
import { FakePushSender } from '../src/notifications/channels/fake-push.sender';
import { testPhones } from './helpers/phone';
import {
  createCompany,
  joinCompany,
  setContactEmail,
  signUp,
  switchTo,
} from './helpers/accounts';

// Delivery is asynchronous (event → queue → worker): allow polling.
jest.setTimeout(30_000);

/**
 * Push end to end with PUSH_SENDER=fake: devices register, an event fans
 * out to email + one push per device, dead tokens clean themselves up,
 * and logout can remove a device.
 */
describe('Push notifications (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: any;
  let fakePush: FakePushSender;

  const companyName = 'PUSH Co';
  const taxId = '550-00-00001';
  const ownerEmail = 'owner@push.test';
  const password = 'password123';

  // accounts.phone is unique across the shared DB: suite 14's own block
  const nextPhone = testPhones(14);

  let adminAccess: string;
  let adminId: string;
  let ownerAccess: string;
  let ownerId: string;
  let memberAccess: string;
  let memberId: string;
  let joinCode: string;

  const auth = (token: string): [string, string] => [
    'Authorization',
    `Bearer ${token}`,
  ];
  const registerDevice = (accessToken: string, token: string) =>
    request(http)
      .post('/devices')
      .set(...auth(accessToken))
      .send({ token: token, platform: 'ANDROID' });
  // Whose phone this is: the device's account, named by its (only) profile.
  const deviceOwner = async (token: string) => {
    const device = await prisma.deviceToken.findUnique({
      where: { token: token },
      select: { account: { select: { profiles: { select: { id: true } } } } },
    });
    return device?.account.profiles[0]?.id ?? null;
  };

  /** A fresh sign-in joins the company and opens its (waiting) profile. */
  const signUpMember = async (email: string) => {
    const session = await signUp(app, nextPhone, {
      email: email,
      password: password,
    });
    const joined = await joinCompany(
      app,
      session,
      joinCode,
      email.split('@')[0],
    );
    const opened = await switchTo(app, session, joined.profileId);
    return { access: opened.accessToken, profileId: joined.profileId };
  };

  /** Wait until a notification row matching `where` reaches `status`. */
  const waitForRow = async (
    where: Record<string, unknown>,
    status: NotificationStatus,
    timeoutMs = 10_000,
  ) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const row = await prisma.notification.findFirst({
        where: { ...where, status: status },
      });
      if (row) {
        return row;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(
      `no ${status} notification matching ${JSON.stringify(where)}`,
    );
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
    fakePush = app.get(FakePushSender);

    const adminLogin = await request(http)
      .post('/auth/login')
      .send({
        email: process.env.SEED_ADMIN_EMAIL,
        password: process.env.SEED_ADMIN_PASSWORD,
      })
      .expect(201);
    adminAccess = adminLogin.body.accessToken;
    adminId = adminLogin.body.profile.id;

    // a pending owner, with the waiting company open, who has proven the
    // address its notifications go to (as the app asks while it waits)
    const session = await signUp(app, nextPhone, {
      email: ownerEmail,
      password: password,
    });
    const created = await createCompany(app, session, {
      companyName: companyName,
      taxId: taxId,
      ownerName: 'Push Owner',
    });
    const opened = await switchTo(app, session, created.profileId);
    await setContactEmail(app, opened, ownerEmail);
    ownerAccess = opened.accessToken;
    ownerId = created.profileId;
  });

  afterAll(async () => {
    await app.close();
  });

  it('a PENDING user can register a device (so the approval push can reach them)', async () => {
    await registerDevice(ownerAccess, 'push-owner-phone').expect(204);

    expect(await deviceOwner('push-owner-phone')).toBe(ownerId);
  });

  it('a token the push provider rejects is refused (400) and not stored', async () => {
    fakePush.markDead('push-garbage-token'); // as FCM would reject a malformed one

    const response = await registerDevice(
      ownerAccess,
      'push-garbage-token',
    ).expect(400);
    expect(response.body.message).toBe('Invalid device token');
    expect(await deviceOwner('push-garbage-token')).toBeNull();
  });

  it('company approval reaches the owner by push AND email', async () => {
    const company = await prisma.company.findUnique({
      where: { taxId: taxId },
    });
    joinCode = company!.joinCode;
    await request(http)
      .patch(`/companies/${company!.id}/approve`)
      .set(...auth(adminAccess))
      .expect(200);

    const pushRow = await waitForRow(
      {
        eventType: NotificationEvent.COMPANY_APPROVED,
        channel: NotificationChannel.PUSH,
        recipientAddress: 'push-owner-phone',
      },
      NotificationStatus.SENT,
    );
    expect(pushRow.recipientProfileId).toBe(ownerId);
    await waitForRow(
      {
        eventType: NotificationEvent.COMPANY_APPROVED,
        channel: NotificationChannel.EMAIL,
        recipientAddress: ownerEmail,
      },
      NotificationStatus.SENT,
    );

    // what the phone would show: the company's name + the template subject
    // as title, the body as body
    const expected = notificationTemplates.companyApproved(companyName);
    // ...and what the app reads on tap: which profile to switch to, then
    // which company to show
    expect(fakePush.lastMessageTo('push-owner-phone')).toEqual({
      to: 'push-owner-phone',
      subject: `${companyName} · ${expected.subject}`,
      body: expected.body,
      data: {
        eventType: 'company.approved',
        companyId: company!.id,
        profileId: ownerId,
      },
    });

    // the deep-link ids live on the row too, so a replayed job keeps them
    expect(pushRow.data).toEqual({
      companyId: company!.id,
      profileId: ownerId,
    });

    ownerAccess = (
      await request(http)
        .post('/auth/login')
        .send({ email: ownerEmail, password: password })
        .expect(201)
    ).body.accessToken;
  });

  it('a recipient with no devices gets the email only', async () => {
    // company.registered went to the platform admin, who has no devices
    await waitForRow(
      {
        eventType: NotificationEvent.COMPANY_REGISTERED,
        channel: NotificationChannel.EMAIL,
        recipientProfileId: adminId,
        body: { contains: companyName },
      },
      NotificationStatus.SENT,
    );
    const adminPushes = await prisma.notification.count({
      where: {
        eventType: NotificationEvent.COMPANY_REGISTERED,
        channel: NotificationChannel.PUSH,
        recipientProfileId: adminId,
      },
    });
    expect(adminPushes).toBe(0);
  });

  it('a token re-registered by another user moves to them (shared phone)', async () => {
    const member = await signUpMember('member@push.test');
    memberAccess = member.access;
    memberId = member.profileId;

    await registerDevice(ownerAccess, 'push-shared-phone').expect(204);
    expect(await deviceOwner('push-shared-phone')).toBe(ownerId);

    await registerDevice(memberAccess, 'push-shared-phone').expect(204);
    expect(await deviceOwner('push-shared-phone')).toBe(memberId);
  });

  it("deleting someone else's device answers 204 but changes nothing", async () => {
    await request(http)
      .delete('/devices/push-shared-phone')
      .set(...auth(ownerAccess))
      .expect(204);

    expect(await deviceOwner('push-shared-phone')).toBe(memberId);
  });

  it('a user can delete their own device', async () => {
    await request(http)
      .delete('/devices/push-shared-phone')
      .set(...auth(memberAccess))
      .expect(204);

    expect(await deviceOwner('push-shared-phone')).toBeNull();
  });

  it('logout with deviceToken removes that device only', async () => {
    await registerDevice(ownerAccess, 'push-owner-tablet').expect(204);
    const session = await request(http)
      .post('/auth/login')
      .send({ email: ownerEmail, password: password })
      .expect(201);

    await request(http)
      .post('/auth/logout')
      .set(...auth(session.body.accessToken))
      .send({
        refreshToken: session.body.refreshToken,
        deviceToken: 'push-owner-tablet',
      })
      .expect(201);

    expect(await deviceOwner('push-owner-tablet')).toBeNull();
    expect(await deviceOwner('push-owner-phone')).toBe(ownerId); // untouched
  });

  it('a dead token: that push FAILS, the device is removed, the healthy one still gets it', async () => {
    await registerDevice(ownerAccess, 'push-dead-phone').expect(204);
    fakePush.markDead('push-dead-phone'); // as if the app was uninstalled

    // member.joinRequested → the owner, on every device
    await signUpMember('second@push.test');

    const deadRow = await waitForRow(
      {
        eventType: NotificationEvent.MEMBER_JOIN_REQUESTED,
        channel: NotificationChannel.PUSH,
        recipientAddress: 'push-dead-phone',
      },
      NotificationStatus.FAILED,
    );
    expect(deadRow.lastError).toBe('device token unregistered');
    expect(deadRow.attempts).toBe(1); // not retried
    expect(await deviceOwner('push-dead-phone')).toBeNull();

    await waitForRow(
      {
        eventType: NotificationEvent.MEMBER_JOIN_REQUESTED,
        channel: NotificationChannel.PUSH,
        recipientAddress: 'push-owner-phone',
      },
      NotificationStatus.SENT,
    );
  });

  it('device endpoints require login (401)', async () => {
    await request(http)
      .post('/devices')
      .send({ token: 'anonymous', platform: 'WEB' })
      .expect(401);
  });
});
