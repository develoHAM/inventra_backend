import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Restock Orders (e2e)', () => {
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
    const taxId = `4${n}0-00-0000${n}`;
    const email = `owner${n}@ord.test`;
    const password = 'password123';
    await request(http)
      .post('/auth/register')
      .send({
        companyName: `ORD Co ${n}`,
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
    const email = `${tag}@ord.test`;
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

  const placeProduct = async (barcode: string): Promise<number> => {
    const categoryId = (
      await request(http)
        .post('/categories')
        .set(...auth(adminAccess))
        .send({ name: `ORD Cat ${barcode}` })
        .expect(201)
    ).body.id;
    const brandId = (
      await request(http)
        .post('/brands')
        .set(...auth(ownerAccess))
        .send({ name: `ORD Brand ${barcode}` })
        .expect(201)
    ).body.id;
    const productId = (
      await request(http)
        .post('/products')
        .set(...auth(ownerAccess))
        .send({ name: `P-${barcode}`, barcode, categoryId, brandId, priceKrw: 1000 })
        .expect(201)
    ).body.id;
    return (
      await request(http)
        .post(`/corners/${cornerId}/products`)
        .set(...auth(ownerAccess))
        .send({ productId, targetStockQuantity: 10 })
        .expect(201)
    ).body.id;
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
        .send({ name: 'ORD Store' })
        .expect(201)
    ).body.id;
    cornerId = (
      await request(http)
        .post('/corners')
        .set(...auth(ownerAccess))
        .send({ storeId, name: 'ORD Corner' })
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

    placementAId = await placeProduct('ORD-BC-A');
    placementBId = await placeProduct('ORD-BC-B');

    const company2 = await registerCompany(2);
    owner2Access = company2.access;
  });

  afterAll(async () => {
    await app.close();
  });

  const base = () => `/corners/${cornerId}/orders`;
  let orderId: string;

  it('OWNER files a restock request with two lines', async () => {
    const res = await request(http)
      .post(base())
      .set(...auth(ownerAccess))
      .send({
        title: 'Weekend restock',
        orderDate: '2026-08-23',
        items: [
          { companyStoreProductId: placementAId, productOrderQuantity: 10 },
          { companyStoreProductId: placementBId, productOrderQuantity: 4 },
        ],
      })
      .expect(201);
    orderId = res.body.id;
    expect(res.body.orderItems).toHaveLength(2);
  });

  it('the request reads back with its items', async () => {
    const res = await request(http)
      .get(`${base()}/${orderId}`)
      .set(...auth(ownerAccess))
      .expect(200);
    expect(res.body.title).toBe('Weekend restock');
    expect(res.body.orderItems).toHaveLength(2);
  });

  it('editing replaces the whole item set', async () => {
    const res = await request(http)
      .patch(`${base()}/${orderId}`)
      .set(...auth(ownerAccess))
      .send({
        title: 'Revised restock',
        items: [{ companyStoreProductId: placementAId, productOrderQuantity: 20 }],
      })
      .expect(200);
    expect(res.body.title).toBe('Revised restock');
    expect(res.body.orderItems).toHaveLength(1);
    expect(res.body.orderItems[0].productOrderQuantity).toBe(20);
  });

  it('an empty item set is rejected (400)', async () => {
    await request(http)
      .patch(`${base()}/${orderId}`)
      .set(...auth(ownerAccess))
      .send({ items: [] })
      .expect(400);
  });

  it("a line that isn't a placement on this corner is rejected (400)", async () => {
    await request(http)
      .post(base())
      .set(...auth(ownerAccess))
      .send({
        title: 'Bad line',
        orderDate: '2026-08-23',
        items: [{ companyStoreProductId: 999999, productOrderQuantity: 1 }],
      })
      .expect(400);
  });

  it('an assigned STAFF can file; a foreign MANAGER is 403', async () => {
    await request(http)
      .post(base())
      .set(...auth(staffAccess))
      .send({
        title: 'Staff order',
        orderDate: '2026-08-23',
        items: [{ companyStoreProductId: placementAId, productOrderQuantity: 1 }],
      })
      .expect(201);
    await request(http)
      .post(base())
      .set(...auth(otherManagerAccess))
      .send({
        title: 'Foreign manager',
        orderDate: '2026-08-23',
        items: [{ companyStoreProductId: placementAId, productOrderQuantity: 1 }],
      })
      .expect(403);
  });

  it("company 2 cannot read company 1's orders (404)", async () => {
    await request(http)
      .get(base())
      .set(...auth(owner2Access))
      .expect(404);
  });

  it('cancel soft-deletes; a re-read is 404', async () => {
    await request(http)
      .delete(`${base()}/${orderId}`)
      .set(...auth(ownerAccess))
      .expect(200);
    await request(http)
      .get(`${base()}/${orderId}`)
      .set(...auth(ownerAccess))
      .expect(404);
  });
});
