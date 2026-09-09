import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Purchase Reservations (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: any;

  let adminAccess: string;
  let ownerAccess: string;
  let staffAccess: string;
  let otherManagerAccess: string;
  let owner2Access: string;

  let cornerId: string;
  let placementId: number;

  let staffUserId: string;

  const auth = (token: string): [string, string] => [
    'Authorization',
    `Bearer ${token}`,
  ];

  const registerCompany = async (n: number) => {
    const taxId = `2${n}0-00-0000${n}`;
    const email = `owner${n}@rsv.test`;
    const password = 'password123';
    await request(http)
      .post('/auth/register')
      .send({
        companyName: `RSV Co ${n}`,
        taxId,
        ownerName: `Owner ${n}`,
        ownerEmail: email,
        ownerPassword: password,
      })
      .expect(201);
    const company = await prisma.company.findUnique({ where: { taxId } });
    await request(http)
      .patch(`/companies/${company!.id}/approve`)
      .set(...auth(adminAccess))
      .expect(200);
    const login = await request(http)
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
    return {
      access: login.body.accessToken as string,
      joinCode: company!.joinCode as string,
    };
  };

  const registerMember = async (
    joinCode: string,
    ownerToken: string,
    roleCode: string,
    tag: string,
  ) => {
    const email = `${tag}@rsv.test`;
    const password = 'password123';
    await request(http)
      .post('/auth/register/member')
      .send({ joinCode, email, password, name: tag })
      .expect(201);
    const user = await prisma.user.findFirst({
      where: { loginMethods: { some: { email } } },
    });
    const role = await prisma.role.findUnique({ where: { code: roleCode } });
    await request(http)
      .patch(`/users/${user!.id}/approve`)
      .set(...auth(ownerToken))
      .send({ roleId: role!.id })
      .expect(200);
    const login = await request(http)
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
    return {
      access: login.body.accessToken as string,
      userId: user!.id as string,
    };
  };

  const stockOf = async (): Promise<{ available: number; reserved: number }> => {
    const res = await request(http)
      .get(`/corners/${cornerId}/products/${placementId}`)
      .set(...auth(ownerAccess))
      .expect(200);
    return {
      available: res.body.stock.availableQuantity,
      reserved: res.body.stock.reservedQuantity,
    };
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

    const adminLogin = await request(http)
      .post('/auth/login')
      .send({
        email: process.env.SEED_ADMIN_EMAIL,
        password: process.env.SEED_ADMIN_PASSWORD,
      })
      .expect(201);
    adminAccess = adminLogin.body.accessToken;

    const company1 = await registerCompany(1);
    ownerAccess = company1.access;
    const staff = await registerMember(company1.joinCode, ownerAccess, 'STAFF', 'staff');
    staffAccess = staff.access;
    staffUserId = staff.userId;
    const otherManager = await registerMember(company1.joinCode, ownerAccess, 'MANAGER', 'othermgr');
    otherManagerAccess = otherManager.access;

    const storeId = (
      await request(http)
        .post('/stores')
        .set(...auth(adminAccess))
        .send({ name: 'RSV Store' })
        .expect(201)
    ).body.id;
    cornerId = (
      await request(http)
        .post('/corners')
        .set(...auth(ownerAccess))
        .send({ storeId, name: 'RSV Corner' })
        .expect(201)
    ).body.id;
    await request(http)
      .post(`/corners/${cornerId}/staff`)
      .set(...auth(ownerAccess))
      .send({ userId: staffUserId })
      .expect(201);

    const categoryId = (
      await request(http)
        .post('/categories')
        .set(...auth(adminAccess))
        .send({ name: 'RSV Cat' })
        .expect(201)
    ).body.id;
    const brandId = (
      await request(http)
        .post('/brands')
        .set(...auth(ownerAccess))
        .send({ name: 'RSV Brand' })
        .expect(201)
    ).body.id;
    const productId = (
      await request(http)
        .post('/products')
        .set(...auth(ownerAccess))
        .send({ name: 'RSV P1', barcode: 'RSV-BC-1', categoryId, brandId, priceKrw: 1000 })
        .expect(201)
    ).body.id;
    placementId = (
      await request(http)
        .post(`/corners/${cornerId}/products`)
        .set(...auth(ownerAccess))
        .send({ productId, targetStockQuantity: 10 })
        .expect(201)
    ).body.id;
    await request(http)
      .post(`/corners/${cornerId}/products/${placementId}/transactions`)
      .set(...auth(ownerAccess))
      .send({ transactionType: 'RESTOCK', quantity: 10 })
      .expect(201);

    const company2 = await registerCompany(2);
    owner2Access = company2.access;
  });

  afterAll(async () => {
    await app.close();
  });

  const base = () => `/corners/${cornerId}/reservations`;
  let reservationId: string;

  it('reserving holds stock (available -> reserved) and logs RESERVATION_HOLD/source=RESERVATION', async () => {
    const res = await request(http)
      .post(base())
      .set(...auth(ownerAccess))
      .send({ companyStoreProductId: placementId, reservedByName: 'Kim', reservedQuantity: 3 })
      .expect(201);
    reservationId = res.body.id;
    expect(res.body.status).toBe('RESERVED');

    expect(await stockOf()).toEqual({ available: 7, reserved: 3 });

    const ledger = await request(http)
      .get(`/corners/${cornerId}/products/${placementId}/transactions`)
      .set(...auth(ownerAccess))
      .expect(200);
    expect(ledger.body[0].transactionType).toBe('RESERVATION_HOLD');
    expect(ledger.body[0].sourceType).toBe('RESERVATION');
  });

  it('the corner-wide list shows the reservation; ?status filters it', async () => {
    const all = await request(http)
      .get(base())
      .set(...auth(ownerAccess))
      .expect(200);
    expect(all.body.some((r: any) => r.id === reservationId)).toBe(true);

    const active = await request(http)
      .get(`${base()}?status=RESERVED`)
      .set(...auth(ownerAccess))
      .expect(200);
    expect(active.body.every((r: any) => r.status === 'RESERVED')).toBe(true);
    expect(active.body.some((r: any) => r.id === reservationId)).toBe(true);
  });

  it('over-reserving beyond available is 409', async () => {
    await request(http)
      .post(base())
      .set(...auth(ownerAccess))
      .send({ companyStoreProductId: placementId, reservedByName: 'Greedy', reservedQuantity: 999 })
      .expect(409);
    expect(await stockOf()).toEqual({ available: 7, reserved: 3 }); // unchanged
  });

  it('fulfilling releases then sells (reserved -> 0) and marks FULFILLED', async () => {
    await request(http)
      .post(`${base()}/${reservationId}/fulfill`)
      .set(...auth(ownerAccess))
      .expect(201);

    expect(await stockOf()).toEqual({ available: 7, reserved: 0 }); // 3 left the reserved pool as a sale

    const ledger = await request(http)
      .get(`/corners/${cornerId}/products/${placementId}/transactions`)
      .set(...auth(ownerAccess))
      .expect(200);
    // both land in the same transaction (same createdAt) — assert order-independently
    const types = ledger.body.slice(0, 2).map((t: any) => t.transactionType).sort();
    expect(types).toEqual(['RESERVATION_RELEASE', 'SALE']);
    expect(ledger.body[0].sourceType).toBe('RESERVATION');
  });

  it('fulfilling an already-fulfilled reservation is 409', async () => {
    await request(http)
      .post(`${base()}/${reservationId}/fulfill`)
      .set(...auth(ownerAccess))
      .expect(409);
  });

  it('an assigned STAFF can reserve, and cancel releases the hold', async () => {
    const res = await request(http)
      .post(base())
      .set(...auth(staffAccess))
      .send({ companyStoreProductId: placementId, reservedByName: 'Lee', reservedQuantity: 2 })
      .expect(201);
    expect(await stockOf()).toEqual({ available: 5, reserved: 2 });

    await request(http)
      .post(`${base()}/${res.body.id}/cancel`)
      .set(...auth(staffAccess))
      .send({ cancelReason: 'changed mind' })
      .expect(201);
    expect(await stockOf()).toEqual({ available: 7, reserved: 0 }); // released back
  });

  it('a foreign MANAGER cannot reserve on this corner (403)', async () => {
    await request(http)
      .post(base())
      .set(...auth(otherManagerAccess))
      .send({ companyStoreProductId: placementId, reservedByName: 'X', reservedQuantity: 1 })
      .expect(403);
  });

  it("company 2 cannot read this corner's reservations (404)", async () => {
    await request(http)
      .get(base())
      .set(...auth(owner2Access))
      .expect(404);
  });
});
