import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { NotificationStatus } from '../src/generated/prisma/enums';
import { NotificationEvent } from '../src/notifications/notification-events';
import { notificationTemplates } from '../src/notifications/notification-templates';

/**
 * End-to-end: HTTP approval → event → listener → Notification row → BullMQ job
 * → worker → SMTP → Mailpit. Requires Postgres, Redis and Mailpit running
 * (`docker compose up -d`).
 */
describe('Notifications (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: any;
  let adminAccess: string;

  const mailpitApi = `http://localhost:${process.env.MAILPIT_UI_PORT ?? 8025}/api/v1`;
  const ownerEmail = 'owner@ntf.test';
  const companyName = 'NTF Co';

  const auth = (token: string): [string, string] => [
    'Authorization',
    `Bearer ${token}`,
  ];

  // Delivery is asynchronous (queue + worker), so poll instead of asserting once.
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

    // Start from an empty inbox for this address, so an earlier run can't
    // make this test pass.
    await fetch(
      `${mailpitApi}/search?query=${encodeURIComponent(`to:${ownerEmail}`)}`,
      { method: 'DELETE' },
    );

    adminAccess = (
      await request(http)
        .post('/auth/login')
        .send({
          email: process.env.SEED_ADMIN_EMAIL,
          password: process.env.SEED_ADMIN_PASSWORD,
        })
        .expect(201)
    ).body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('approving a company emails its owner (row SENT, message in Mailpit)', async () => {
    const taxId = '770-00-00001';
    await request(http)
      .post('/auth/register')
      .send({
        companyName: companyName,
        taxId: taxId,
        ownerName: 'Owner',
        ownerEmail: ownerEmail,
        ownerPassword: 'password123',
      })
      .expect(201);
    const company = await prisma.company.findUnique({
      where: { taxId: taxId },
    });

    await request(http)
      .patch(`/companies/${company!.id}/approve`)
      .set(...auth(adminAccess))
      .expect(200);

    // 1) the worker delivered it and recorded the outcome
    const notification = await waitFor(() =>
      prisma.notification.findFirst({
        where: {
          eventType: NotificationEvent.COMPANY_APPROVED,
          recipientAddress: ownerEmail,
          status: NotificationStatus.SENT,
        },
      }),
    );
    const expected = notificationTemplates.companyApproved(companyName);
    expect(notification.subject).toBe(expected.subject);
    expect(notification.attempts).toBe(1);
    expect(notification.sentAt).toBeInstanceOf(Date);

    // 2) the email really went over SMTP and landed in Mailpit
    const search = await waitFor(async () => {
      const response = await fetch(
        `${mailpitApi}/search?query=${encodeURIComponent(`to:${ownerEmail}`)}`,
      );
      const body = (await response.json()) as {
        messages: { Subject: string }[];
      };
      return body.messages.length > 0 ? body : null;
    });
    expect(search.messages[0].Subject).toBe(expected.subject);
  });
});
