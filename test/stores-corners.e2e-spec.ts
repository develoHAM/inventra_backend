import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Stores & Corners (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: any;

  let adminAccess: string;
  let ownerAccess: string;
  let managerAccess: string;
  let otherManagerAccess: string;
  let owner2Access: string;

  let company1Id: string;
  let managerUserId: string;
  let staffUserId: string;

  let storeId: string;
  let cornerId: string;

  // A well-formed UUID that will not exist in the DB (for the invalid-store case).
  const MISSING_UUID = '11111111-1111-4111-8111-111111111111';

  // register a company → ADMIN approves it → owner logs in
  const registerCompany = async (n: number) => {
    const taxId = `8${n}0-00-0000${n}`;
    const email = `owner${n}@sc.test`;
    const password = 'password123';
    await request(http)
      .post('/auth/register')
      .send({
        companyName: `SC Co ${n}`,
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
    const email = `${tag}@sc.test`;
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

    const c1 = await registerCompany(1);
    ownerAccess = c1.access;
    company1Id = c1.companyId;

    const mgr = await registerMember(c1.joinCode, ownerAccess, 'MANAGER', 'manager');
    managerAccess = mgr.access;
    managerUserId = mgr.userId;

    const staff = await registerMember(c1.joinCode, ownerAccess, 'STAFF', 'staff');
    staffUserId = staff.userId;

    const other = await registerMember(
      c1.joinCode,
      ownerAccess,
      'MANAGER',
      'othermanager',
    );
    otherManagerAccess = other.access;

    const c2 = await registerCompany(2);
    owner2Access = c2.access;
  });

  afterAll(async () => {
    await app.close();
  });

  it('ADMIN creates a global store; a company user cannot (403)', async () => {
    const res = await request(http)
      .post('/stores')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ name: 'Lotte Jamsil' })
      .expect(201);
    storeId = res.body.id;

    await request(http)
      .post('/stores')
      .set('Authorization', `Bearer ${ownerAccess}`)
      .send({ name: 'Nope' })
      .expect(403);
  });

  it('OWNER opens a corner in the store; an invalid storeId is 400', async () => {
    const res = await request(http)
      .post('/corners')
      .set('Authorization', `Bearer ${ownerAccess}`)
      .send({ storeId, name: 'A-1' })
      .expect(201);
    cornerId = res.body.id;

    await request(http)
      .post('/corners')
      .set('Authorization', `Bearer ${ownerAccess}`)
      .send({ storeId: MISSING_UUID, name: 'X' })
      .expect(400);
  });

  it('OWNER appoints a MANAGER; a STAFF-role target is 400', async () => {
    await request(http)
      .put(`/corners/${cornerId}/manager`)
      .set('Authorization', `Bearer ${ownerAccess}`)
      .send({ userId: managerUserId })
      .expect(200);

    await request(http)
      .put(`/corners/${cornerId}/manager`)
      .set('Authorization', `Bearer ${ownerAccess}`)
      .send({ userId: staffUserId })
      .expect(400);
  });

  it('the corner MANAGER adds staff; a foreign MANAGER is 403', async () => {
    await request(http)
      .post(`/corners/${cornerId}/staff`)
      .set('Authorization', `Bearer ${managerAccess}`)
      .send({ userId: staffUserId })
      .expect(201);

    await request(http)
      .post(`/corners/${cornerId}/staff`)
      .set('Authorization', `Bearer ${otherManagerAccess}`)
      .send({ userId: staffUserId })
      .expect(403);
  });

  it('the corner MANAGER removes staff; removing a non-staff user is 404', async () => {
    await request(http)
      .delete(`/corners/${cornerId}/staff/${staffUserId}`)
      .set('Authorization', `Bearer ${managerAccess}`)
      .expect(200);

    await request(http)
      .delete(`/corners/${cornerId}/staff/${staffUserId}`)
      .set('Authorization', `Bearer ${managerAccess}`)
      .expect(404);
  });

  it("company 2 cannot fetch company 1's corner (404); ADMIN reads it and creates via companyId", async () => {
    await request(http)
      .get(`/corners/${cornerId}`)
      .set('Authorization', `Bearer ${owner2Access}`)
      .expect(404);

    await request(http)
      .get(`/corners/${cornerId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);

    await request(http)
      .post('/corners')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ storeId, name: 'admin-made', companyId: company1Id })
      .expect(201);
  });
});
