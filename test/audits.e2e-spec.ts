import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Inventory Audits (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: any;

  let adminAccess: string;
  let ownerAccess: string;
  let staffAccess: string;
  let otherManagerAccess: string;
  let owner2Access: string;

  let cornerId: string;
  let placementAId: number;
  let placementBId: number;

  let managerUserId: string;
  let staffUserId: string;

  const auth = (token: string): [string, string] => [
    'Authorization',
    `Bearer ${token}`,
  ];

  const registerCompany = async (n: number) => {
    const taxId = `3${n}0-00-0000${n}`;
    const email = `owner${n}@aud.test`;
    const password = 'password123';
    await request(http)
      .post('/auth/register')
      .send({
        companyName: `AUD Co ${n}`,
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
    const email = `${tag}@aud.test`;
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

  const placeProduct = async (
    barcode: string,
    initialStock: number,
  ): Promise<number> => {
    const categoryId = (
      await request(http)
        .post('/categories')
        .set(...auth(adminAccess))
        .send({ name: `AUD Cat ${barcode}` })
        .expect(201)
    ).body.id;
    const brandId = (
      await request(http)
        .post('/brands')
        .set(...auth(ownerAccess))
        .send({ name: `AUD Brand ${barcode}` })
        .expect(201)
    ).body.id;
    const productId = (
      await request(http)
        .post('/products')
        .set(...auth(ownerAccess))
        .send({ name: `P-${barcode}`, barcode, categoryId, brandId, priceKrw: 1000 })
        .expect(201)
    ).body.id;
    const placementId = (
      await request(http)
        .post(`/corners/${cornerId}/products`)
        .set(...auth(ownerAccess))
        .send({ productId, targetStockQuantity: 10 })
        .expect(201)
    ).body.id;
    // seed some starting stock so the audit produces a visible variance
    await request(http)
      .post(`/corners/${cornerId}/products/${placementId}/transactions`)
      .set(...auth(ownerAccess))
      .send({ transactionType: 'RESTOCK', quantity: initialStock })
      .expect(201);
    return placementId;
  };

  const stockOf = async (placementId: number): Promise<number> => {
    const res = await request(http)
      .get(`/corners/${cornerId}/products/${placementId}`)
      .set(...auth(ownerAccess))
      .expect(200);
    return res.body.stock.availableQuantity;
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
    const manager = await registerMember(company1.joinCode, ownerAccess, 'MANAGER', 'manager');
    managerUserId = manager.userId;
    const staff = await registerMember(company1.joinCode, ownerAccess, 'STAFF', 'staff');
    staffAccess = staff.access;
    staffUserId = staff.userId;
    const otherManager = await registerMember(company1.joinCode, ownerAccess, 'MANAGER', 'othermgr');
    otherManagerAccess = otherManager.access;

    const storeId = (
      await request(http)
        .post('/stores')
        .set(...auth(adminAccess))
        .send({ name: 'AUD Store' })
        .expect(201)
    ).body.id;
    cornerId = (
      await request(http)
        .post('/corners')
        .set(...auth(ownerAccess))
        .send({ storeId, name: 'AUD Corner' })
        .expect(201)
    ).body.id;
    await request(http)
      .put(`/corners/${cornerId}/manager`)
      .set(...auth(ownerAccess))
      .send({ userId: managerUserId })
      .expect(200);
    await request(http)
      .post(`/corners/${cornerId}/staff`)
      .set(...auth(ownerAccess))
      .send({ userId: staffUserId })
      .expect(201);

    placementAId = await placeProduct('AUD-BC-A', 5);
    placementBId = await placeProduct('AUD-BC-B', 5);

    const company2 = await registerCompany(2);
    owner2Access = company2.access;
  });

  afterAll(async () => {
    await app.close();
  });

  const base = () => `/corners/${cornerId}/audits`;
  let auditId: string;

  it('OWNER files a count over two placements', async () => {
    const res = await request(http)
      .post(base())
      .set(...auth(ownerAccess))
      .send({
        title: 'Monthly count',
        auditedDate: '2026-08-28',
        items: [
          { companyStoreProductId: placementAId, productQuantity: 12 },
          { companyStoreProductId: placementBId, productQuantity: 0 },
        ],
      })
      .expect(201);
    auditId = res.body.id;
    expect(res.body.inventoryAuditItems).toHaveLength(2);
    expect(res.body.appliedAt).toBeNull();
  });

  it('applying reconciles each placement to its counted number', async () => {
    await request(http)
      .post(`${base()}/${auditId}/apply`)
      .set(...auth(ownerAccess))
      .expect(201);

    expect(await stockOf(placementAId)).toBe(12); // was 5, counted 12
    expect(await stockOf(placementBId)).toBe(0);  // was 5, counted 0

    const ledger = await request(http)
      .get(`/corners/${cornerId}/products/${placementAId}/transactions`)
      .set(...auth(ownerAccess))
      .expect(200);
    expect(ledger.body[0].transactionType).toBe('ADJUSTMENT');
    expect(ledger.body[0].sourceType).toBe('AUDIT');
    expect(ledger.body[0].quantityAfter).toBe(12);
  });

  it('re-applying an applied audit is 409', async () => {
    await request(http)
      .post(`${base()}/${auditId}/apply`)
      .set(...auth(ownerAccess))
      .expect(409);
  });

  it('editing an applied audit is 409', async () => {
    await request(http)
      .patch(`${base()}/${auditId}`)
      .set(...auth(ownerAccess))
      .send({ title: 'nope' })
      .expect(409);
  });

  it('a foreign-placement line is 400', async () => {
    await request(http)
      .post(base())
      .set(...auth(ownerAccess))
      .send({
        title: 'Bad line',
        auditedDate: '2026-08-28',
        items: [{ companyStoreProductId: 999999, productQuantity: 1 }],
      })
      .expect(400);
  });

  it('an assigned STAFF can file and apply; a foreign MANAGER is 403', async () => {
    const staffAudit = await request(http)
      .post(base())
      .set(...auth(staffAccess))
      .send({
        title: 'Staff count',
        auditedDate: '2026-08-28',
        items: [{ companyStoreProductId: placementAId, productQuantity: 3 }],
      })
      .expect(201);
    await request(http)
      .post(`${base()}/${staffAudit.body.id}/apply`)
      .set(...auth(staffAccess))
      .expect(201);
    expect(await stockOf(placementAId)).toBe(3);

    await request(http)
      .post(base())
      .set(...auth(otherManagerAccess))
      .send({
        title: 'Foreign',
        auditedDate: '2026-08-28',
        items: [{ companyStoreProductId: placementAId, productQuantity: 1 }],
      })
      .expect(403);
  });

  it("company 2 cannot read company 1's audits (404)", async () => {
    await request(http)
      .get(base())
      .set(...auth(owner2Access))
      .expect(404);
  });
});
