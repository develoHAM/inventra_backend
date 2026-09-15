import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('File Uploads (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: any;

  let adminAccess: string;
  let ownerAccess: string;
  let productId: string;
  let brandId: number;

  const auth = (token: string): [string, string] => [
    'Authorization',
    `Bearer ${token}`,
  ];

  // a valid 1x1 PNG
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );

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

    adminAccess = (
      await request(http)
        .post('/auth/login')
        .send({
          email: process.env.SEED_ADMIN_EMAIL,
          password: process.env.SEED_ADMIN_PASSWORD,
        })
        .expect(201)
    ).body.accessToken;

    const taxId = '110-00-00001';
    const email = 'owner1@upl.test';
    const password = 'password123';
    await request(http)
      .post('/auth/register')
      .send({
        companyName: 'UPL Co',
        taxId: taxId,
        ownerName: 'Owner',
        ownerEmail: email,
        ownerPassword: password,
      })
      .expect(201);
    const company = await prisma.company.findUnique({
      where: { taxId: taxId },
    });
    await request(http)
      .patch(`/companies/${company!.id}/approve`)
      .set(...auth(adminAccess))
      .expect(200);
    ownerAccess = (
      await request(http)
        .post('/auth/login')
        .send({ email: email, password: password })
        .expect(201)
    ).body.accessToken;

    const categoryId = (
      await request(http)
        .post('/categories')
        .set(...auth(adminAccess))
        .send({ name: 'UPL Cat' })
        .expect(201)
    ).body.id;
    brandId = (
      await request(http)
        .post('/brands')
        .set(...auth(ownerAccess))
        .send({ name: 'UPL Brand' })
        .expect(201)
    ).body.id;
    productId = (
      await request(http)
        .post('/products')
        .set(...auth(ownerAccess))
        .send({
          name: 'UPL P1',
          barcode: 'UPL-BC-1',
          categoryId: categoryId,
          brandId: brandId,
          priceKrw: 1000,
        })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('proxied upload sets imageUrl to a presigned URL; a later read re-presigns', async () => {
    const res = await request(http)
      .post(`/products/${productId}/image`)
      .set(...auth(ownerAccess))
      .attach('file', PNG, 'p.png')
      .expect(201);
    expect(res.body.imageUrl).toContain('X-Amz-Signature');

    const read = await request(http)
      .get(`/products/${productId}`)
      .set(...auth(ownerAccess))
      .expect(200);
    expect(read.body.imageUrl).toContain('X-Amz-Signature');
  });

  it('rejects a non-image upload (400)', async () => {
    await request(http)
      .post(`/products/${productId}/image`)
      .set(...auth(ownerAccess))
      .attach('file', Buffer.from('not an image'), 'x.txt')
      .expect(400);
  });

  it('presigned flow: presign -> PUT to storage -> confirm sets imageUrl', async () => {
    const presign = await request(http)
      .post(`/products/${productId}/image/presign`)
      .set(...auth(ownerAccess))
      .send({ contentType: 'image/png' })
      .expect(201);

    // upload the bytes DIRECTLY to MinIO via the presigned PUT URL (not supertest)
    const put = await fetch(presign.body.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: PNG,
    });
    expect(put.ok).toBe(true);

    const confirm = await request(http)
      .post(`/products/${productId}/image/confirm`)
      .set(...auth(ownerAccess))
      .send({ key: presign.body.key })
      .expect(201);
    expect(confirm.body.imageUrl).toContain('X-Amz-Signature');
  });

  it('confirm rejects a key that is not under this product (400)', async () => {
    await request(http)
      .post(`/products/${productId}/image/confirm`)
      .set(...auth(ownerAccess))
      .send({ key: 'products/other/x.png' })
      .expect(400);
  });

  // ── Brand logo ──
  it('brand logo: proxied upload sets a presigned logoUrl; a later read re-presigns', async () => {
    const res = await request(http)
      .post(`/brands/${brandId}/logo`)
      .set(...auth(ownerAccess))
      .attach('file', PNG, 'logo.png')
      .expect(201);
    expect(res.body.logoUrl).toContain('X-Amz-Signature');

    const read = await request(http)
      .get(`/brands/${brandId}`)
      .set(...auth(ownerAccess))
      .expect(200);
    expect(read.body.logoUrl).toContain('X-Amz-Signature');
  });

  it('brand logo: presign -> PUT to storage -> confirm sets logoUrl', async () => {
    const presign = await request(http)
      .post(`/brands/${brandId}/logo/presign`)
      .set(...auth(ownerAccess))
      .send({ contentType: 'image/png' })
      .expect(201);

    const put = await fetch(presign.body.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: PNG,
    });
    expect(put.ok).toBe(true);

    const confirm = await request(http)
      .post(`/brands/${brandId}/logo/confirm`)
      .set(...auth(ownerAccess))
      .send({ key: presign.body.key })
      .expect(201);
    expect(confirm.body.logoUrl).toContain('X-Amz-Signature');
  });

  it('brand logo: confirm rejects a key that is not under this brand (400)', async () => {
    await request(http)
      .post(`/brands/${brandId}/logo/confirm`)
      .set(...auth(ownerAccess))
      .send({ key: 'brands/999999/x.png' })
      .expect(400);
  });

  // ── User avatar (self-service) ──
  it('avatar: proxied upload sets a presigned profileImageUrl', async () => {
    const res = await request(http)
      .post('/users/me/avatar')
      .set(...auth(ownerAccess))
      .attach('file', PNG, 'me.png')
      .expect(201);
    expect(res.body.profileImageUrl).toContain('X-Amz-Signature');
  });

  it('avatar: presign -> PUT to storage -> confirm sets profileImageUrl', async () => {
    const presign = await request(http)
      .post('/users/me/avatar/presign')
      .set(...auth(ownerAccess))
      .send({ contentType: 'image/png' })
      .expect(201);

    const put = await fetch(presign.body.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: PNG,
    });
    expect(put.ok).toBe(true);

    const confirm = await request(http)
      .post('/users/me/avatar/confirm')
      .set(...auth(ownerAccess))
      .send({ key: presign.body.key })
      .expect(201);
    expect(confirm.body.profileImageUrl).toContain('X-Amz-Signature');
  });

  it('avatar: confirm rejects a key not under the caller (400)', async () => {
    await request(http)
      .post('/users/me/avatar/confirm')
      .set(...auth(ownerAccess))
      .send({ key: 'users/not-me/x.png' })
      .expect(400);
  });
});
