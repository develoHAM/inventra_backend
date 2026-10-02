import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { testPhones, verifiedPhone } from './helpers/phone';
import { NotificationStatus } from '../src/generated/prisma/enums';
import { NotificationEvent } from '../src/notifications/notification-events';
import { notificationTemplates } from '../src/notifications/notification-templates';

/**
 * End-to-end: HTTP approval → event → listener → Notification row → BullMQ job
 * → worker → SMTP → Mailpit. Requires Postgres, Redis and Mailpit running
 * (`docker compose up -d`).
 */
// Each test polls for async delivery (waitFor allows 10 s), so Jest's 5 s
// default would cut a slow wait short with a less useful message.
jest.setTimeout(30_000);

describe('Notifications (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: any;
  let adminAccess: string;

  const mailpitApi = `http://localhost:${process.env.MAILPIT_UI_PORT ?? 8025}/api/v1`;
  const ownerEmail = 'owner@ntf.test';
  const companyName = 'NTF Co';

  // users.phone is unique across the shared DB: suite 10's own block
  const nextPhone = testPhones(10);

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
    const { phone, token } = await verifiedPhone(app, nextPhone);
    await request(http)
      .post('/auth/register')
      .send({
        companyName: companyName,
        taxId: taxId,
        ownerName: 'Owner',
        ownerEmail: ownerEmail,
        ownerPassword: 'password123',
        ownerPhone: phone,
        ownerPhoneVerificationToken: token,
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

  describe('Slice 1b events', () => {
    const companyName = 'NTF 1b Co';
    const taxId = '771-00-00001';
    const ownerEmail1b = 'owner-1b@ntf.test';
    const managerEmail = 'manager-1b@ntf.test';
    const password = 'password123';

    let ownerAccess: string;
    let managerAccess: string;
    let managerUserId: string;
    let cornerId: string;
    let placementId: number;

    const login = async (email: string) =>
      (
        await request(http)
          .post('/auth/login')
          .send({ email: email, password: password })
          .expect(201)
      ).body.accessToken as string;

    // Start from an empty inbox for this block's addresses (see the 1a test).
    beforeAll(async () => {
      for (const email of [ownerEmail1b, managerEmail]) {
        await fetch(
          `${mailpitApi}/search?query=${encodeURIComponent(`to:${email}`)}`,
          { method: 'DELETE' },
        );
      }
    });

    /**
     * Wait until a SENT row exists for this event + address. `bodyContains`
     * narrows it to OUR row when the address is shared: the admin already has
     * company.registered rows from the suites that ran before this one.
     */
    const sentTo = (
      eventType: string,
      recipientAddress: string,
      bodyContains?: string,
    ) =>
      waitFor(async () => {
        const rows = await prisma.notification.findMany({
          where: {
            eventType: eventType,
            recipientAddress: recipientAddress,
            status: NotificationStatus.SENT,
            ...(bodyContains ? { body: { contains: bodyContains } } : {}),
          },
        });
        return rows.length > 0 ? rows : null;
      });

    it('company.registered emails the platform admin', async () => {
      const { phone, token } = await verifiedPhone(app, nextPhone);
      await request(http)
        .post('/auth/register')
        .send({
          companyName: companyName,
          taxId: taxId,
          ownerName: 'Owner 1b',
          ownerEmail: ownerEmail1b,
          ownerPassword: password,
          ownerPhone: phone,
          ownerPhoneVerificationToken: token,
        })
        .expect(201);

      const rows = await sentTo(
        NotificationEvent.COMPANY_REGISTERED,
        process.env.SEED_ADMIN_EMAIL!,
        companyName,
      );
      expect(rows).toHaveLength(1);

      // approve it so the owner can act in the next steps
      const company = await prisma.company.findUnique({
        where: { taxId: taxId },
      });
      await request(http)
        .patch(`/companies/${company!.id}/approve`)
        .set(...auth(adminAccess))
        .expect(200);
      ownerAccess = await login(ownerEmail1b);
    });

    it('member.joinRequested emails the owner; member.approved emails the member', async () => {
      const company = await prisma.company.findUnique({
        where: { taxId: taxId },
      });
      const { phone, token } = await verifiedPhone(app, nextPhone);
      await request(http)
        .post('/auth/register/member')
        .send({
          joinCode: company!.joinCode,
          email: managerEmail,
          password: password,
          name: 'Manager 1b',
          phone: phone,
          phoneVerificationToken: token,
        })
        .expect(201);

      const requested = await sentTo(
        NotificationEvent.MEMBER_JOIN_REQUESTED,
        ownerEmail1b,
      );
      expect(requested[0].body).toContain('Manager 1b');

      const member = await prisma.user.findFirst({
        where: { loginMethods: { some: { email: managerEmail } } },
      });
      managerUserId = member!.id;
      const managerRole = await prisma.role.findUnique({
        where: { code: 'MANAGER' },
      });
      await request(http)
        .patch(`/users/${managerUserId}/approve`)
        .set(...auth(ownerAccess))
        .send({ roleId: managerRole!.id })
        .expect(200);

      await sentTo(NotificationEvent.MEMBER_APPROVED, managerEmail);
      managerAccess = await login(managerEmail);
    });

    it('order.created emails the owner but NOT the manager who filed it', async () => {
      // corner managed by the new manager, with one placed product (target 10)
      const storeId = (
        await request(http)
          .post('/stores')
          .set(...auth(adminAccess))
          .send({ name: 'NTF 1b Store' })
          .expect(201)
      ).body.id;
      cornerId = (
        await request(http)
          .post('/corners')
          .set(...auth(ownerAccess))
          .send({ storeId: storeId, name: 'NTF 1b Corner' })
          .expect(201)
      ).body.id;
      await request(http)
        .put(`/corners/${cornerId}/manager`)
        .set(...auth(ownerAccess))
        .send({ userId: managerUserId })
        .expect(200);
      const categoryId = (
        await request(http)
          .post('/categories')
          .set(...auth(adminAccess))
          .send({ name: 'NTF 1b Cat' })
          .expect(201)
      ).body.id;
      const brandId = (
        await request(http)
          .post('/brands')
          .set(...auth(ownerAccess))
          .send({ name: 'NTF 1b Brand' })
          .expect(201)
      ).body.id;
      const productId = (
        await request(http)
          .post('/products')
          .set(...auth(ownerAccess))
          .send({
            name: 'Cola 500ml',
            barcode: 'NTF-1B-COLA',
            categoryId: categoryId,
            brandId: brandId,
            priceKrw: 1500,
          })
          .expect(201)
      ).body.id;
      placementId = (
        await request(http)
          .post(`/corners/${cornerId}/products`)
          .set(...auth(ownerAccess))
          .send({ productId: productId, targetStockQuantity: 10 })
          .expect(201)
      ).body.id;

      await request(http)
        .post(`/corners/${cornerId}/orders`)
        .set(...auth(managerAccess))
        .send({
          title: 'Restock request',
          orderDate: '2026-09-27',
          items: [
            { companyStoreProductId: placementId, productOrderQuantity: 20 },
          ],
        })
        .expect(201);

      await sentTo(NotificationEvent.ORDER_CREATED, ownerEmail1b);
      const toManager = await prisma.notification.count({
        where: {
          eventType: NotificationEvent.ORDER_CREATED,
          recipientAddress: managerEmail,
        },
      });
      expect(toManager).toBe(0); // the actor is excluded
    });

    it('stock.belowTarget alerts manager AND owner once on the crossing, not again after', async () => {
      const transactions = `/corners/${cornerId}/products/${placementId}/transactions`;

      // 0 → 12: rising, no alert
      await request(http)
        .post(transactions)
        .set(...auth(ownerAccess))
        .send({ transactionType: 'RESTOCK', quantity: 12 })
        .expect(201);
      // 12 → 7: crosses below the target of 10 → alert
      await request(http)
        .post(transactions)
        .set(...auth(managerAccess))
        .send({ transactionType: 'SALE', quantity: 5 })
        .expect(201);

      const toOwner = await sentTo(
        NotificationEvent.STOCK_BELOW_TARGET,
        ownerEmail1b,
      );
      // nobody is excluded, including the manager who made the sale
      await sentTo(NotificationEvent.STOCK_BELOW_TARGET, managerEmail);
      expect(toOwner[0].body).toContain('7개');

      // 7 → 6: already below, so no new alert
      await request(http)
        .post(transactions)
        .set(...auth(managerAccess))
        .send({ transactionType: 'SALE', quantity: 1 })
        .expect(201);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      // scoped to this suite's recipients: other suites share the database
      const alerts = await prisma.notification.count({
        where: {
          eventType: NotificationEvent.STOCK_BELOW_TARGET,
          recipientAddress: { in: [ownerEmail1b, managerEmail] },
        },
      });
      expect(alerts).toBe(2); // one for the owner, one for the manager

      // and the owner's alert really arrived by email
      const search = await waitFor(async () => {
        const response = await fetch(
          `${mailpitApi}/search?query=${encodeURIComponent(`to:${ownerEmail1b}`)}`,
        );
        const body = (await response.json()) as {
          messages: { Subject: string }[];
        };
        return body.messages.some(
          (message) => message.Subject === '[Inventra] 재고 부족 알림',
        )
          ? body
          : null;
      });
      expect(search.messages.length).toBeGreaterThan(0);
    });
  });
});
