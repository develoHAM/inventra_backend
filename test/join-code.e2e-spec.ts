import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { testPhones } from './helpers/phone';
import { createCompany, signUp, switchTo } from './helpers/accounts';

/**
 * GET /companies/me/join-code (OWNER + MANAGER) and
 * POST /companies/me/join-code/rotate (OWNER) — and that a rotated code
 * really changes who can join. (Guessing codes is braked per account:
 * see accounts.e2e-spec.)
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

  // accounts.phone is unique across the shared DB: suite 12's own block
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

  /** A fresh sign-in joins with `joinCode`; returns the join's HTTP response. */
  const signUpMember = async (joinCode: string, email: string) => {
    const session = await signUp(app, nextPhone, {
      email: email,
      password: password,
    });
    return request(http)
      .post('/me/companies/join')
      .set(...auth(session.accessToken))
      .send({ joinCode: joinCode, name: email.split('@')[0] });
  };

  /** Join via the current code, then the owner approves with a role. */
  const approvedMember = async (email: string, roleCode: string) => {
    // awaiting signUpMember already sent the request: check the response
    const joined = await signUpMember(await joinCodeInDb(), email);
    expect(joined.status).toBe(201);
    const role = await prisma.role.findUnique({ where: { code: roleCode } });
    await request(http)
      .patch(`/profiles/${joined.body.profileId}/approve`)
      .set(...auth(ownerAccess))
      .send({ roleId: role!.id, cornerId: null })
      .expect(200);
    return login(email); // their only company opens
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
    const session = await signUp(app, nextPhone, {
      email: 'owner@jc.test',
      password: password,
    });
    const created = await createCompany(app, session, {
      companyName: 'JC Co',
      taxId: taxId,
      ownerName: 'JC Owner',
    });
    companyId = created.companyId;
    const pendingOwner = await switchTo(app, session, created.profileId);

    await request(http)
      .get('/companies/me/join-code')
      .set(...auth(pendingOwner.accessToken))
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
