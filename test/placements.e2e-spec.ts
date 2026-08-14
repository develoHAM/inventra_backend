import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Product Placement (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: any;

  let adminAccess: string;
  let ownerAccess: string;
  let staffAccess: string;
  let otherManagerAccess: string;
  let owner2Access: string;

  let categoryId: number;
  let brandId: number;
  let productId: string;
  let product2Id: string;
  let company2ProductId: string;

  let storeId: string;
  let cornerId: string;
  let placementId: number;

  let managerUserId: string;
  let staffUserId: string;

  const auth = (token: string): [string, string] => [
    'Authorization',
    `Bearer ${token}`,
  ];

  // register a company → ADMIN approves it → owner logs in
  const registerCompany = async (n: number) => {
    const taxId = `6${n}0-00-0000${n}`;
    const email = `owner${n}@pl.test`;
    const password = 'password123';
    await request(http)
      .post('/auth/register')
      .send({
        companyName: `PL Co ${n}`,
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

  // member self-registers → owner approves with a role → member logs in
  const registerMember = async (
    joinCode: string,
    ownerToken: string,
    roleCode: string,
    tag: string,
  ) => {
    const email = `${tag}@pl.test`;
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

    // company 1: owner + a manager + a staff + a second (unrelated) manager
    const c1 = await registerCompany(1);
    ownerAccess = c1.access;
    const mgr = await registerMember(c1.joinCode, ownerAccess, 'MANAGER', 'manager');
    managerUserId = mgr.userId;
    const stf = await registerMember(c1.joinCode, ownerAccess, 'STAFF', 'staff');
    staffAccess = stf.access;
    staffUserId = stf.userId;
    const other = await registerMember(
      c1.joinCode,
      ownerAccess,
      'MANAGER',
      'othermgr',
    );
    otherManagerAccess = other.access;

    // catalog for company 1: category (ADMIN) + brand (owner) + two products
    categoryId = (
      await request(http)
        .post('/categories')
        .set(...auth(adminAccess))
        .send({ name: 'PL Cat' })
        .expect(201)
    ).body.id;
    brandId = (
      await request(http)
        .post('/brands')
        .set(...auth(ownerAccess))
        .send({ name: 'PL Brand' })
        .expect(201)
    ).body.id;
    productId = (
      await request(http)
        .post('/products')
        .set(...auth(ownerAccess))
        .send({ name: 'P1', barcode: 'PL-BC-1', categoryId, brandId, priceKrw: 1000 })
        .expect(201)
    ).body.id;
    product2Id = (
      await request(http)
        .post('/products')
        .set(...auth(ownerAccess))
        .send({ name: 'P2', barcode: 'PL-BC-2', categoryId, brandId, priceKrw: 2000 })
        .expect(201)
    ).body.id;

    // store (ADMIN) + corner (owner) + appoint manager + assign staff to it
    storeId = (
      await request(http)
        .post('/stores')
        .set(...auth(adminAccess))
        .send({ name: 'PL Store' })
        .expect(201)
    ).body.id;
    cornerId = (
      await request(http)
        .post('/corners')
        .set(...auth(ownerAccess))
        .send({ storeId, name: 'PL Corner' })
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

    // company 2: its own brand + product (for the cross-company rejection)
    const c2 = await registerCompany(2);
    owner2Access = c2.access;
    const brand2Id = (
      await request(http)
        .post('/brands')
        .set(...auth(owner2Access))
        .send({ name: 'PL Brand2' })
        .expect(201)
    ).body.id;
    company2ProductId = (
      await request(http)
        .post('/products')
        .set(...auth(owner2Access))
        .send({ name: 'P2C2', barcode: 'PL-BC-9', categoryId, brandId: brand2Id, priceKrw: 500 })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('OWNER places a product on the corner; a duplicate is 409', async () => {
    const res = await request(http)
      .post(`/corners/${cornerId}/products`)
      .set(...auth(ownerAccess))
      .send({ productId, targetStockQuantity: 10 })
      .expect(201);
    placementId = res.body.id;

    await request(http)
      .post(`/corners/${cornerId}/products`)
      .set(...auth(ownerAccess))
      .send({ productId })
      .expect(409);
  });

  it("rejects another company's product with 400", async () => {
    await request(http)
      .post(`/corners/${cornerId}/products`)
      .set(...auth(ownerAccess))
      .send({ productId: company2ProductId })
      .expect(400);
  });

  it('an assigned STAFF member can place a product (delivery scenario) and read the shelf', async () => {
    await request(http)
      .post(`/corners/${cornerId}/products`)
      .set(...auth(staffAccess))
      .send({ productId: product2Id, targetStockQuantity: 4 })
      .expect(201);

    await request(http)
      .get(`/corners/${cornerId}/products`)
      .set(...auth(staffAccess))
      .expect(200);
  });

  it('a MANAGER of a different corner cannot touch this shelf (403)', async () => {
    await request(http)
      .patch(`/corners/${cornerId}/products/${placementId}`)
      .set(...auth(otherManagerAccess))
      .send({ targetStockQuantity: 1 })
      .expect(403);
  });

  it('soft-delete then re-place the same product revives the same row', async () => {
    await request(http)
      .delete(`/corners/${cornerId}/products/${placementId}`)
      .set(...auth(ownerAccess))
      .expect(200);

    const res = await request(http)
      .post(`/corners/${cornerId}/products`)
      .set(...auth(ownerAccess))
      .send({ productId, targetStockQuantity: 7 })
      .expect(201);
    expect(res.body.id).toBe(placementId); // revived, not a new row
  });

  it("company 2 cannot read company 1's corner shelf (404)", async () => {
    await request(http)
      .get(`/corners/${cornerId}/products`)
      .set(...auth(owner2Access))
      .expect(404);
  });
});
