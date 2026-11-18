import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { testPhones } from './helpers/phone';
import { suiteAccounts } from './helpers/accounts';

describe('Stores & Corners (e2e)', () => {
  let app: INestApplication;
  let http: any;

  let adminAccess: string;
  let ownerAccess: string;
  let managerAccess: string;
  let otherManagerAccess: string;
  let owner2Access: string;

  let company1Id: string;
  let managerProfileId: string;
  let staffProfileId: string;

  let storeId: string;
  let cornerId: string;

  // A well-formed UUID that will not exist in the DB (for the invalid-store case).
  const MISSING_UUID = '11111111-1111-4111-8111-111111111111';

  // accounts.phone is unique across the shared DB: suite 03's own block
  const nextPhone = testPhones(3);

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
    http = app.getHttpServer();
    const accounts = suiteAccounts(app, {
      nextPhone: nextPhone,
      emailDomain: 'sc.test',
      taxIdOf: (n) => `8${n}0-00-0000${n}`,
      companyNameOf: (n) => `SC Co ${n}`,
    });

    const adminLogin = await request(http)
      .post('/auth/login')
      .send({
        email: process.env.SEED_ADMIN_EMAIL,
        password: process.env.SEED_ADMIN_PASSWORD,
      })
      .expect(201);
    adminAccess = adminLogin.body.accessToken;

    const c1 = await accounts.registerOwner(adminAccess, 1);
    ownerAccess = c1.access;
    company1Id = c1.companyId;

    const mgr = await accounts.registerJoinedMember(
      ownerAccess,
      c1.joinCode,
      'MANAGER',
      'manager',
    );
    managerAccess = mgr.access;
    managerProfileId = mgr.profileId;

    const staff = await accounts.registerJoinedMember(
      ownerAccess,
      c1.joinCode,
      'STAFF',
      'staff',
    );
    staffProfileId = staff.profileId;

    const other = await accounts.registerJoinedMember(
      ownerAccess,
      c1.joinCode,
      'MANAGER',
      'othermanager',
    );
    otherManagerAccess = other.access;

    const c2 = await accounts.registerOwner(adminAccess, 2);
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
      .send({ storeId: storeId, name: 'A-1' })
      .expect(201);
    cornerId = res.body.id;

    await request(http)
      .post('/corners')
      .set('Authorization', `Bearer ${ownerAccess}`)
      .send({ storeId: MISSING_UUID, name: 'X' })
      .expect(400);
  });

  const moveTo = (profileId: string, toCornerId: string | null) =>
    request(http)
      .put(`/profiles/${profileId}/branch`)
      .set('Authorization', `Bearer ${ownerAccess}`)
      .send({ cornerId: toCornerId });

  // Reads are company-wide; writes check the branch (assertWorksCorner).
  // A made-up product passes the branch check (→ 400 Invalid product) only
  // for someone who works in that branch; anyone else is stopped first (403).
  const placeMissingProduct = (access: string, inCornerId: string) =>
    request(http)
      .post(`/corners/${inCornerId}/products`)
      .set('Authorization', `Bearer ${access}`)
      .send({ productId: MISSING_UUID });

  it('OWNER puts the manager and the staff member in the corner', async () => {
    const manager = await moveTo(managerProfileId, cornerId).expect(200);
    expect(manager.body.branch).toEqual({ id: cornerId, name: 'A-1' });

    await moveTo(staffProfileId, cornerId).expect(200);
  });

  it("the corner's MANAGER works it; a manager of no branch is 403", async () => {
    await placeMissingProduct(managerAccess, cornerId).expect(400);
    await placeMissingProduct(otherManagerAccess, cornerId).expect(403);
  });

  it('a manager moved to another branch is judged by the new one, with the same token', async () => {
    const otherCornerId = (
      await request(http)
        .post('/corners')
        .set('Authorization', `Bearer ${ownerAccess}`)
        .send({ storeId: storeId, name: 'A-2' })
        .expect(201)
    ).body.id;

    await moveTo(managerProfileId, otherCornerId).expect(200);

    await placeMissingProduct(managerAccess, cornerId).expect(403);
    await placeMissingProduct(managerAccess, otherCornerId).expect(400);

    await moveTo(managerProfileId, cornerId).expect(200); // back, for the rest of the suite
  });

  it('a corner no longer takes a manager (400: managerProfileId is not a field)', async () => {
    await request(http)
      .post('/corners')
      .set('Authorization', `Bearer ${ownerAccess}`)
      .send({ storeId: storeId, name: 'X', managerProfileId: managerProfileId })
      .expect(400);
  });

  it('the old corner assignment routes are gone (404)', async () => {
    await request(http)
      .put(`/corners/${cornerId}/manager`)
      .set('Authorization', `Bearer ${ownerAccess}`)
      .send({ profileId: managerProfileId })
      .expect(404);
    await request(http)
      .post(`/corners/${cornerId}/staff`)
      .set('Authorization', `Bearer ${ownerAccess}`)
      .send({ profileId: staffProfileId })
      .expect(404);
    await request(http)
      .delete(`/corners/${cornerId}/staff/${staffProfileId}`)
      .set('Authorization', `Bearer ${ownerAccess}`)
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
      .send({ storeId: storeId, name: 'admin-made', companyId: company1Id })
      .expect(201);
  });
});
