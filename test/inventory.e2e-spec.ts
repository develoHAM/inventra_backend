import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { suiteAccounts } from './helpers/accounts';
import { testPhones } from './helpers/phone';

describe('Inventory Transactions (e2e)', () => {
  let app: INestApplication;
  let accounts: ReturnType<typeof suiteAccounts>;
  let http: any;

  let adminAccess: string;
  let ownerAccess: string;
  let staffAccess: string;
  let otherManagerAccess: string;
  let owner2Access: string;

  let categoryId: number;
  let brandId: number;
  let productId: string;

  let storeId: string;
  let cornerId: string;
  let placementId: number;

  let managerProfileId: string;
  let staffProfileId: string;

  const auth = (token: string): [string, string] => [
    'Authorization',
    `Bearer ${token}`,
  ];

  // accounts.phone is unique across the shared DB: suite 05's own block
  const nextPhone = testPhones(5);

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
    accounts = suiteAccounts(app, {
      nextPhone: nextPhone,
      emailDomain: 'inv.test',
      taxIdOf: (n) => `5${n}0-00-0000${n}`,
      companyNameOf: (n) => `INV Co ${n}`,
    });
    http = app.getHttpServer();

    const adminLogin = await request(http)
      .post('/auth/login')
      .send({
        email: process.env.SEED_ADMIN_EMAIL,
        password: process.env.SEED_ADMIN_PASSWORD,
      })
      .expect(201);
    adminAccess = adminLogin.body.accessToken;

    // company 1: owner + a corner-managed manager + a corner-assigned staff +
    // a second (unrelated) manager
    const company1 = await accounts.registerOwner(adminAccess, 1);
    ownerAccess = company1.access;
    const manager = await accounts.registerJoinedMember(
      ownerAccess,
      company1.joinCode,
      'MANAGER',
      'manager',
    );
    managerProfileId = manager.profileId;
    const staff = await accounts.registerJoinedMember(
      ownerAccess,
      company1.joinCode,
      'STAFF',
      'staff',
    );
    staffAccess = staff.access;
    staffProfileId = staff.profileId;
    const otherManager = await accounts.registerJoinedMember(
      ownerAccess,
      company1.joinCode,
      'MANAGER',
      'othermgr',
    );
    otherManagerAccess = otherManager.access;

    // catalog for company 1: category (ADMIN) + brand (owner) + one product
    categoryId = (
      await request(http)
        .post('/categories')
        .set(...auth(adminAccess))
        .send({ name: 'INV Cat' })
        .expect(201)
    ).body.id;
    brandId = (
      await request(http)
        .post('/brands')
        .set(...auth(ownerAccess))
        .send({ name: 'INV Brand' })
        .expect(201)
    ).body.id;
    productId = (
      await request(http)
        .post('/products')
        .set(...auth(ownerAccess))
        .send({
          name: 'INV P1',
          barcode: 'INV-BC-1',
          categoryId: categoryId,
          brandId: brandId,
          priceKrw: 1000,
        })
        .expect(201)
    ).body.id;

    // store (ADMIN) + corner (owner) + appoint the manager + assign the staff
    storeId = (
      await request(http)
        .post('/stores')
        .set(...auth(adminAccess))
        .send({ name: 'INV Store' })
        .expect(201)
    ).body.id;
    cornerId = (
      await request(http)
        .post('/corners')
        .set(...auth(ownerAccess))
        .send({ storeId: storeId, name: 'INV Corner' })
        .expect(201)
    ).body.id;
    await request(http)
      .post(`/profiles/${managerProfileId}/branches`)
      .set(...auth(ownerAccess))
      .send({ cornerId: cornerId })
      .expect(201);
    await request(http)
      .post(`/profiles/${staffProfileId}/branches`)
      .set(...auth(ownerAccess))
      .send({ cornerId: cornerId })
      .expect(201);

    // the placement whose stock these transactions move (starts at 0 in every bucket)
    placementId = (
      await request(http)
        .post(`/corners/${cornerId}/products`)
        .set(...auth(ownerAccess))
        .send({ productId: productId, targetStockQuantity: 10 })
        .expect(201)
    ).body.id;

    // company 2: an unrelated, approved owner (for the cross-tenant rejection)
    const company2 = await accounts.registerOwner(adminAccess, 2);
    owner2Access = company2.access;
  });

  afterAll(async () => {
    await app.close();
  });

  const base = () =>
    `/corners/${cornerId}/products/${placementId}/transactions`;
  const shelf = () => `/corners/${cornerId}/products/${placementId}`;

  it('RESTOCK raises available; SALE lowers it; the ledger lists both', async () => {
    await request(http)
      .post(base())
      .set(...auth(ownerAccess))
      .send({ transactionType: 'RESTOCK', quantity: 10 })
      .expect(201);
    await request(http)
      .post(base())
      .set(...auth(ownerAccess))
      .send({ transactionType: 'SALE', quantity: 3 })
      .expect(201);

    const shelfRes = await request(http)
      .get(shelf())
      .set(...auth(ownerAccess))
      .expect(200);
    expect(shelfRes.body.stock.availableQuantity).toBe(7);

    const ledger = await request(http)
      .get(base())
      .set(...auth(ownerAccess))
      .expect(200);
    expect(ledger.body.length).toBe(2);
    // newest-first
    expect(ledger.body[0].transactionType).toBe('SALE');
    expect(ledger.body[0].quantityBefore).toBe(10);
    expect(ledger.body[0].quantityAfter).toBe(7);
  });

  it('overselling is 409 and leaves the balance unchanged', async () => {
    await request(http)
      .post(base())
      .set(...auth(ownerAccess))
      .send({ transactionType: 'SALE', quantity: 999 })
      .expect(409);

    const shelfRes = await request(http)
      .get(shelf())
      .set(...auth(ownerAccess))
      .expect(200);
    expect(shelfRes.body.stock.availableQuantity).toBe(7);
  });

  it('ADJUSTMENT sets available to the counted total', async () => {
    await request(http)
      .post(base())
      .set(...auth(ownerAccess))
      .send({ transactionType: 'ADJUSTMENT', quantity: 5 })
      .expect(201);

    const shelfRes = await request(http)
      .get(shelf())
      .set(...auth(ownerAccess))
      .expect(200);
    expect(shelfRes.body.stock.availableQuantity).toBe(5);
  });

  it('BREAKAGE moves available -> damaged (total unchanged)', async () => {
    await request(http)
      .post(base())
      .set(...auth(ownerAccess))
      .send({ transactionType: 'BREAKAGE', quantity: 2 })
      .expect(201);

    const shelfRes = await request(http)
      .get(shelf())
      .set(...auth(ownerAccess))
      .expect(200);
    expect(shelfRes.body.stock.availableQuantity).toBe(3);
    expect(shelfRes.body.stock.damagedQuantity).toBe(2);
  });

  it('an assigned STAFF records a SALE; a foreign MANAGER is 403', async () => {
    await request(http)
      .post(base())
      .set(...auth(staffAccess))
      .send({ transactionType: 'SALE', quantity: 1 })
      .expect(201);
    await request(http)
      .post(base())
      .set(...auth(otherManagerAccess))
      .send({ transactionType: 'SALE', quantity: 1 })
      .expect(403);
  });

  it('rejects an unknown transaction type with 400', async () => {
    await request(http)
      .post(base())
      .set(...auth(ownerAccess))
      .send({ transactionType: 'NONSENSE', quantity: 1 })
      .expect(400);
  });

  it("company 2 cannot post to company 1's placement (404)", async () => {
    await request(http)
      .post(base())
      .set(...auth(owner2Access))
      .send({ transactionType: 'SALE', quantity: 1 })
      .expect(404);
  });
});
