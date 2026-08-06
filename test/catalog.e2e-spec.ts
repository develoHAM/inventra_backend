import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Product Catalog (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: any;

  let adminAccess: string;
  let ownerAccess: string;
  let staffAccess: string;
  let managerAccess: string;
  let owner2Access: string;

  let company1Id: string;
  let categoryId: number;
  let brandId: number;
  let productId: string;

  // register a company → ADMIN approves it → owner logs in
  const registerCompany = async (n: number) => {
    const taxId = `9${n}0-00-0000${n}`;
    const email = `owner${n}@cat.test`;
    const password = 'password123';
    await request(http)
      .post('/auth/register')
      .send({
        companyName: `Cat Co ${n}`,
        taxId,
        ownerName: `Owner ${n}`,
        ownerEmail: email,
        ownerPassword: password,
      })
      .expect(201);
    const company = await prisma.company.findUnique({ where: { taxId } });
    await request(http)
      .patch(`/companies/${company!.id}/approve`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    const login = await request(http)
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
    return {
      access: login.body.accessToken as string,
      companyId: company!.id as string,
      joinCode: company!.joinCode as string,
    };
  };

  // member self-registers via join code → owner approves with a role → member logs in
  const registerMember = async (
    joinCode: string,
    ownerToken: string,
    roleCode: string,
    tag: string,
  ) => {
    const email = `${tag}@cat.test`;
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
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ roleId: role!.id })
      .expect(200);
    const login = await request(http)
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
    return login.body.accessToken as string;
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

    const c1 = await registerCompany(1);
    ownerAccess = c1.access;
    company1Id = c1.companyId;
    staffAccess = await registerMember(c1.joinCode, ownerAccess, 'STAFF', 'staff');
    managerAccess = await registerMember(
      c1.joinCode,
      ownerAccess,
      'MANAGER',
      'manager',
    );

    const c2 = await registerCompany(2);
    owner2Access = c2.access;
  });

  afterAll(async () => {
    await app.close();
  });

  it('ADMIN creates a global category; a company user cannot (403)', async () => {
    const res = await request(http)
      .post('/categories')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ name: 'Beverages' })
      .expect(201);
    categoryId = res.body.id;

    await request(http)
      .post('/categories')
      .set('Authorization', `Bearer ${ownerAccess}`)
      .send({ name: 'Snacks' })
      .expect(403);
  });

  it('OWNER creates a brand, then a product referencing it', async () => {
    const brand = await request(http)
      .post('/brands')
      .set('Authorization', `Bearer ${ownerAccess}`)
      .send({ name: 'AcmeBrand' })
      .expect(201);
    brandId = brand.body.id;

    const product = await request(http)
      .post('/products')
      .set('Authorization', `Bearer ${ownerAccess}`)
      .send({ name: 'Cola', barcode: 'CAT-BC-1', categoryId, brandId, priceKrw: 1500 })
      .expect(201);
    productId = product.body.id;
  });

  it("rejects a product that references another company's brand (400)", async () => {
    // company 2 tries to use company 1's brand
    await request(http)
      .post('/products')
      .set('Authorization', `Bearer ${owner2Access}`)
      .send({ name: 'Fake', barcode: 'CAT-BC-2', categoryId, brandId, priceKrw: 100 })
      .expect(400);
  });

  it('rejects a duplicate barcode (409)', async () => {
    await request(http)
      .post('/products')
      .set('Authorization', `Bearer ${ownerAccess}`)
      .send({ name: 'Dup', barcode: 'CAT-BC-1', categoryId, brandId, priceKrw: 200 })
      .expect(409);
  });

  it('STAFF can read products but not create one (403)', async () => {
    await request(http)
      .get('/products')
      .set('Authorization', `Bearer ${staffAccess}`)
      .expect(200);

    await request(http)
      .post('/products')
      .set('Authorization', `Bearer ${staffAccess}`)
      .send({ name: 'Nope', barcode: 'CAT-BC-3', categoryId, brandId, priceKrw: 100 })
      .expect(403);
  });

  it('a MANAGER cannot delete a product they did not create (403)', async () => {
    await request(http)
      .delete(`/products/${productId}`)
      .set('Authorization', `Bearer ${managerAccess}`)
      .expect(403);
  });

  it("company 2 cannot fetch company 1's product (404, no leak)", async () => {
    await request(http)
      .get(`/products/${productId}`)
      .set('Authorization', `Bearer ${owner2Access}`)
      .expect(404);
  });

  it('ADMIN reads across tenants and can create for a company via companyId', async () => {
    // cross-tenant read
    await request(http)
      .get(`/products/${productId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);

    // cross-tenant create (must name the target company + use one of its brands)
    await request(http)
      .post('/products')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        name: 'AdminMade',
        barcode: 'CAT-BC-9',
        categoryId,
        brandId,
        companyId: company1Id,
        priceKrw: 500,
      })
      .expect(201);
  });
});
