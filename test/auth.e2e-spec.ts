import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Auth & Authorization (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: any;

  const owner = {
    companyName: 'E2E Corp',
    taxId: '111-11-11111',
    ownerName: 'E2E Owner',
    ownerEmail: 'owner@e2e.test',
    ownerPassword: 'password123',
  };
  const member = {
    email: 'member@e2e.test',
    password: 'password123',
    name: 'E2E Member',
  };

  let ownerAccess: string;
  let adminAccess: string;
  let companyId: string;
  let joinCode: string;
  let memberId: string;
  let memberAccess: string;

  const loginMember = () =>
    request(http)
      .post('/auth/login')
      .send({ email: member.email, password: member.password });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    // main.ts does not run in tests — re-apply the same global pipe
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
  });

  afterAll(async () => {
    await app.close();
  });

  it('1. registers a company — owner PENDING with an auto-login session', async () => {
    const res = await request(http)
      .post('/auth/register')
      .send(owner)
      .expect(201);

    expect(res.body.user.status).toBe('PENDING_APPROVAL');
    expect(res.body.accessToken).toEqual(expect.any(String));
    ownerAccess = res.body.accessToken;
  });

  it('2. a PENDING owner is blocked from protected routes (403)', async () => {
    await request(http)
      .patch('/users/00000000-0000-0000-0000-000000000000/approve')
      .set('Authorization', `Bearer ${ownerAccess}`)
      .send({ roleId: 1 })
      .expect(403);
  });

  it('3. platform admin logs in', async () => {
    const res = await request(http)
      .post('/auth/login')
      .send({
        email: process.env.SEED_ADMIN_EMAIL,
        password: process.env.SEED_ADMIN_PASSWORD,
      })
      .expect(201);

    adminAccess = res.body.accessToken;
  });

  it('4. admin approves the company (owner → ACTIVE)', async () => {
    // no endpoint exposes the join code yet — read it straight from the DB
    const company = await prisma.company.findUnique({
      where: { taxId: owner.taxId },
    });
    companyId = company!.id;
    joinCode = company!.joinCode;

    await request(http)
      .patch(`/companies/${companyId}/approve`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
  });

  it('5. the owner can now log in as ACTIVE', async () => {
    const res = await request(http)
      .post('/auth/login')
      .send({ email: owner.ownerEmail, password: owner.ownerPassword })
      .expect(201);

    expect(res.body.user.status).toBe('ACTIVE');
    ownerAccess = res.body.accessToken;
  });

  it('6. a member self-registers with the join code (PENDING, role-less)', async () => {
    const res = await request(http)
      .post('/auth/register/member')
      .send({ ...member, joinCode })
      .expect(201);

    expect(res.body.user.status).toBe('PENDING_APPROVAL');
    expect(res.body.user.roleId).toBeNull();
  });

  it('7. an unknown join code is rejected (404)', async () => {
    await request(http)
      .post('/auth/register/member')
      .send({
        ...member,
        email: 'nobody@e2e.test',
        joinCode: 'INV-DOESNOTEXIST',
      })
      .expect(404);
  });

  it('8. the owner approves the member with the STAFF role', async () => {
    const memberUser = await prisma.user.findFirst({
      where: { loginMethods: { some: { email: member.email } } },
    });
    memberId = memberUser!.id;
    const staff = await prisma.role.findUnique({ where: { code: 'STAFF' } });

    await request(http)
      .patch(`/users/${memberId}/approve`)
      .set('Authorization', `Bearer ${ownerAccess}`)
      .send({ roleId: staff!.id })
      .expect(200);
  });

  it('9. the member logs in as ACTIVE and reaches /auth/me', async () => {
    const res = await loginMember().expect(201);
    memberAccess = res.body.accessToken;
    expect(res.body.user.status).toBe('ACTIVE');

    const me = await request(http)
      .get('/auth/me')
      .set('Authorization', `Bearer ${memberAccess}`)
      .expect(200);

    expect(me.body.id).toBe(memberId);
    expect(me.body.status).toBe('ACTIVE');
  });

  it('10. refresh rotates the token; replaying the old one is caught as reuse (401)', async () => {
    const { body } = await loginMember().expect(201);
    const oldRefresh = body.refreshToken;

    const rotated = await request(http)
      .post('/auth/refresh')
      .send({ refreshToken: oldRefresh })
      .expect(201);
    expect(rotated.body.refreshToken).toEqual(expect.any(String));

    // replay the now-revoked token → reuse detection → 401
    await request(http)
      .post('/auth/refresh')
      .send({ refreshToken: oldRefresh })
      .expect(401);
  });

  it('11. logout revokes the refresh token', async () => {
    const { body } = await loginMember().expect(201);

    await request(http)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${body.accessToken}`)
      .send({ refreshToken: body.refreshToken })
      .expect(201);

    // the revoked token can no longer refresh
    await request(http)
      .post('/auth/refresh')
      .send({ refreshToken: body.refreshToken })
      .expect(401);
  });

  it('12. a STAFF member cannot approve a company (403), but ADMIN could', async () => {
    const { body } = await loginMember().expect(201);

    await request(http)
      .patch(`/companies/${companyId}/approve`)
      .set('Authorization', `Bearer ${body.accessToken}`)
      .expect(403);
  });
});
