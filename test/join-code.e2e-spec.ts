import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { testPhones, verifiedPhone } from './helpers/phone';

/**
 * GET /companies/me/join-code (OWNER + MANAGER) and
 * POST /companies/me/join-code/rotate (OWNER) — and that a rotated code
 * really changes who can sign up.
 */
describe('Company join code (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: any;

  let adminAccess: string;
  let ownerAccess: string;
  let managerAccess: string;
  let staffAccess: string;
  let companyId: string;

  const taxId = '990-00-00001';
  const password = 'password123';

  // users.phone is unique across the shared DB: suite 12's own block
  const nextPhone = testPhones(12);

  const auth = (token: string): [string, string] => [
    'Authorization',
    `Bearer ${token}`,
  ];

  const login = async (email: string, loginPassword = password) =>
    (
      await request(http)
        .post('/auth/login')
        .send({ email: email, password: loginPassword })
        .expect(201)
    ).body.accessToken as string;

  const joinCodeInDb = async () =>
    (await prisma.company.findUnique({ where: { id: companyId } }))!.joinCode;

  /** Member signup with a fresh verified phone; returns the HTTP response. */
  const signUpMember = async (joinCode: string, email: string) => {
    const { phone, token } = await verifiedPhone(app, nextPhone);
    return request(http)
      .post('/auth/register/member')
      .send({
        joinCode: joinCode,
        email: email,
        password: password,
        name: email.split('@')[0],
        phone: phone,
        phoneVerificationToken: token,
      });
  };

  /** Sign up via the current code, then the owner approves with a role. */
  const approvedMember = async (email: string, roleCode: string) => {
    // awaiting signUpMember already sent the request: check the response
    const signUp = await signUpMember(await joinCodeInDb(), email);
    expect(signUp.status).toBe(201);
    const user = await prisma.user.findFirst({
      where: { loginMethods: { some: { email: email } } },
    });
    const role = await prisma.role.findUnique({ where: { code: roleCode } });
    await request(http)
      .patch(`/users/${user!.id}/approve`)
      .set(...auth(ownerAccess))
      .send({ roleId: role!.id })
      .expect(200);
    return login(email);
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

    adminAccess = await login(
      process.env.SEED_ADMIN_EMAIL!,
      process.env.SEED_ADMIN_PASSWORD,
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('a pending owner cannot see the code yet (403)', async () => {
    const { phone, token } = await verifiedPhone(app, nextPhone);
    const registered = await request(http)
      .post('/auth/register')
      .send({
        companyName: 'JC Co',
        taxId: taxId,
        ownerName: 'JC Owner',
        ownerEmail: 'owner@jc.test',
        ownerPassword: password,
        ownerPhone: phone,
        ownerPhoneVerificationToken: token,
      })
      .expect(201);
    companyId = (await prisma.company.findUnique({
      where: { taxId: taxId },
    }))!.id;

    await request(http)
      .get('/companies/me/join-code')
      .set(...auth(registered.body.accessToken))
      .expect(403);
  });

  it('new companies get an 8-digit code', async () => {
    expect(await joinCodeInDb()).toMatch(/^\d{8}$/);
  });

  it('once approved, the owner reads the code', async () => {
    await request(http)
      .patch(`/companies/${companyId}/approve`)
      .set(...auth(adminAccess))
      .expect(200);
    ownerAccess = await login('owner@jc.test');

    const response = await request(http)
      .get('/companies/me/join-code')
      .set(...auth(ownerAccess))
      .expect(200);
    expect(response.body).toEqual({ joinCode: await joinCodeInDb() });
  });

  it('a manager reads the code too', async () => {
    managerAccess = await approvedMember('manager@jc.test', 'MANAGER');

    const response = await request(http)
      .get('/companies/me/join-code')
      .set(...auth(managerAccess))
      .expect(200);
    expect(response.body).toEqual({ joinCode: await joinCodeInDb() });
  });

  it('staff cannot read the code (403)', async () => {
    staffAccess = await approvedMember('staff@jc.test', 'STAFF');

    await request(http)
      .get('/companies/me/join-code')
      .set(...auth(staffAccess))
      .expect(403);
  });

  it('managers and staff cannot rotate (403)', async () => {
    const before = await joinCodeInDb();

    await request(http)
      .post('/companies/me/join-code/rotate')
      .set(...auth(managerAccess))
      .expect(403);
    await request(http)
      .post('/companies/me/join-code/rotate')
      .set(...auth(staffAccess))
      .expect(403);
    expect(await joinCodeInDb()).toBe(before);
  });

  it('the platform admin has no company of its own (403)', async () => {
    const response = await request(http)
      .get('/companies/me/join-code')
      .set(...auth(adminAccess))
      .expect(403);
    expect(response.body.message).toBe('You do not belong to a company');
  });

  it('the owner rotates: a new code, the old one stops working, the new one works', async () => {
    const oldCode = await joinCodeInDb();

    const response = await request(http)
      .post('/companies/me/join-code/rotate')
      .set(...auth(ownerAccess))
      .expect(200);
    const newCode: string = response.body.joinCode;

    expect(newCode).toMatch(/^\d{8}$/);
    expect(newCode).not.toBe(oldCode);
    expect(await joinCodeInDb()).toBe(newCode);

    const viaOldCode = await signUpMember(oldCode, 'late@jc.test');
    expect(viaOldCode.status).toBe(404);

    // typed the way people copy it from a screen: grouped with a space
    const grouped = `${newCode.slice(0, 4)} ${newCode.slice(4)}`;
    const viaNewCode = await signUpMember(grouped, 'newcomer@jc.test');
    expect(viaNewCode.status).toBe(201);
  });

  it('existing members are unaffected by rotation', async () => {
    await request(http)
      .get('/companies/me/join-code')
      .set(...auth(managerAccess))
      .expect(200);
  });

  it('a malformed code is rejected before any lookup (400)', async () => {
    const response = await signUpMember('INV-3FA91C07B2DE', 'typo@jc.test');

    expect(response.status).toBe(400);
    expect(response.body.message).toEqual(['joinCode must be 8 digits']);
  });
});
