# File Uploads — Slice 1: Storage Foundation & Product Image — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up S3-compatible object storage (MinIO) behind a generic `StorageService`, and use it to upload `product.imageUrl` via both a proxied and a presigned flow, with private storage + presign-on-read.

**Architecture:** A `@Global()` `StorageModule`/`StorageService` wraps `@aws-sdk/client-s3` (endpoint → MinIO). `ProductsService` gains image methods that build keys, upload/delete via `StorageService`, and store the object **key** in `imageUrl`; product reads **present** the key as a short-lived presigned GET URL.

**Tech Stack:** NestJS 11, `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, `@nestjs/platform-express` (Multer), MinIO (Docker), Prisma 7, Jest + supertest.

**Spec:** `docs/superpowers/specs/2026-09-10-file-uploads-storage-product-image-design.md`

## Global Constraints

- **MinIO is the server (Docker); the AWS S3 SDK is the client.** `endpoint` + `forcePathStyle: true` are the only MinIO-specific client settings. Prod swap to real S3/R2 = env only.
- **Private bucket, presign-on-read.** DB stores the object **key**; reads return a presigned GET URL. `imageUrl == null` stays `null`.
- **Key scheme:** `products/{productId}/{uuid}.{ext}`; `ext` from MIME (`image/jpeg→jpg`, `image/png→png`, `image/webp→webp`). Allowed image MIME: jpeg/png/webp. Max size: **5 MB**.
- **Replace deletes the old object.** Both flows delete the previous key before setting the new one.
- **Authz:** `products.update` + the product's existing company ownership (reuse `ProductsService` lookups).
- **Claude cannot run `prisma migrate`, `npm run test:e2e`, or the app against MinIO** — a human runs the e2e (with MinIO up) and recreates the gitignored `.env`/`.env.test`. Claude runs `npm test`, `npm run build`.
- No schema/migration change this slice (`imageUrl` already exists).

---

## File Structure

- `package.json` — **modify**: add `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@types/multer` (dev).
- `docker-compose.yml` — **modify**: add a `minio` service + `inventra_miniodata` volume.
- `src/config/env.schema.ts` — **modify**: add the `S3_*` block.
- `.env` / `.env.test` — **human recreates** (gitignored): `MINIO_*` (compose) + `S3_*` (app).
- `src/storage/storage.service.ts` — **create**: the S3 wrapper.
- `src/storage/storage.module.ts` — **create**: `@Global()` module.
- `src/app.module.ts` — **modify**: register `StorageModule`.
- `src/products/dto/presign-image.dto.ts`, `confirm-image.dto.ts` — **create**.
- `src/products/products.service.ts` — **modify**: inject `StorageService`; add `present()`, `findOneRaw()`, `uploadImage`, `presignImageUpload`, `confirmImage`; presign-on-read in `findOne`/`findAll`.
- `src/products/products.controller.ts` — **modify**: 3 image routes.
- `src/products/products.service.spec.ts` — **modify (tests)**: storage mock + image tests.
- `test/uploads.e2e-spec.ts` — **create (tests)**: proxied + presigned flows (human runs, MinIO up).

---

## Task 1: Deps + infra + `StorageService` + wiring

**Files:**
- Modify: `package.json`, `docker-compose.yml`, `src/config/env.schema.ts`, `src/app.module.ts`, `.env`, `.env.test`
- Create: `src/storage/storage.service.ts`, `src/storage/storage.module.ts`

**Interfaces:**
- Produces: `StorageService` with `putObject(key, body, contentType)`, `presignPutUrl(key, contentType)`, `presignGetUrl(key)`, `objectExists(key)`, `deleteObject(key)` — exported globally by `StorageModule`.

- [ ] **Step 1: Install the SDK packages**

```bash
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
npm install -D @types/multer
```

- [ ] **Step 2: Add the `minio` service to `docker-compose.yml`**

Under `services:` (alongside `postgres`/`redis`):
```yaml
  minio:
    image: minio/minio
    container_name: inventra_minio
    restart: unless-stopped
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
    ports:
      - '${MINIO_PORT}:9000'
      - '${MINIO_CONSOLE_PORT}:9001'
    volumes:
      - inventra_miniodata:/data
    healthcheck:
      test: ['CMD', 'mc', 'ready', 'local']
      interval: 5s
      timeout: 5s
      retries: 5
```
and add `inventra_miniodata:` under the top-level `volumes:`.

- [ ] **Step 3: Add `S3_*` to `src/config/env.schema.ts`**

Inside the `z.object({ … })`, after the Seed block:
```ts
  // -- Storage (S3 / MinIO) --
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_PRESIGN_EXPIRY_SECONDS: z.coerce.number().int().positive().default(300),
```

- [ ] **Step 4: Add env vars to `.env` and `.env.test`** (gitignored — human edits both)

`.env`:
```
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=minioadmin
MINIO_PORT=9000
MINIO_CONSOLE_PORT=9001
S3_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET=inventra-files
S3_PRESIGN_EXPIRY_SECONDS=300
```
`.env.test` — identical **except a separate bucket**:
```
S3_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET=inventra-files-test
S3_PRESIGN_EXPIRY_SECONDS=300
```
Then `docker compose up -d` (starts MinIO; console at http://localhost:9001, login `minioadmin`/`minioadmin`).

- [ ] **Step 5: Write `src/storage/storage.service.ts`**

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Env } from '../config/env.schema';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly presignExpiry: number;

  constructor(config: ConfigService<Env, true>) {
    this.client = new S3Client({
      endpoint: config.get('S3_ENDPOINT', { infer: true }),
      region: config.get('S3_REGION', { infer: true }),
      forcePathStyle: true, // MinIO uses path-style addressing (endpoint/bucket/key)
      credentials: {
        accessKeyId: config.get('S3_ACCESS_KEY', { infer: true }),
        secretAccessKey: config.get('S3_SECRET_KEY', { infer: true }),
      },
    });
    this.bucket = config.get('S3_BUCKET', { infer: true });
    this.presignExpiry = config.get('S3_PRESIGN_EXPIRY_SECONDS', {
      infer: true,
    });
  }

  // Ensure the bucket exists on boot (HeadBucket → CreateBucket on miss).
  async onModuleInit(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`Created storage bucket "${this.bucket}"`);
    }
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  // A temporary UPLOAD permit — the client PUTs bytes straight to storage.
  presignPutUrl(key: string, contentType: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn: this.presignExpiry },
    );
  }

  // A temporary DOWNLOAD permit — used for presign-on-read.
  presignGetUrl(key: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: this.presignExpiry },
    );
  }

  async objectExists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}
```

- [ ] **Step 6: Write `src/storage/storage.module.ts`**

```ts
import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';

@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
```

- [ ] **Step 7: Register `StorageModule` in `src/app.module.ts`**

Add the import and place `StorageModule` in the `imports` array (near `PrismaModule`, since it's a global infra module):
```ts
import { StorageModule } from './storage/storage.module';
```

- [ ] **Step 8: Build + full unit suite (compiles + nothing regressed)**

Run: `npm run build`
Expected: exits 0.
Run: `npm test`
Expected: PASS — 170 (unchanged; `StorageService` isn't unit-tested here — it's exercised for real by the e2e against MinIO in Task 3).

*(Functional MinIO check — bucket auto-create + real put/get — happens when the human boots the app / runs the e2e with MinIO up.)*

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json docker-compose.yml src/config/env.schema.ts src/storage src/app.module.ts
git commit -m "feat(storage): MinIO/S3 StorageService (put/presign/exists/delete) + docker + env"
```

---

## Task 2: Product image — service + controller + DTOs (+ unit tests)

**Files:**
- Create: `src/products/dto/presign-image.dto.ts`, `src/products/dto/confirm-image.dto.ts`
- Modify: `src/products/products.service.ts`, `src/products/products.controller.ts`
- Test: `src/products/products.service.spec.ts`

**Interfaces:**
- Consumes: `StorageService` (Task 1).
- Produces: `ProductsService.uploadImage(caller, id, file)`, `presignImageUpload(caller, id, dto)`, `confirmImage(caller, id, dto)`; `findOne`/`findAll` presign-on-read.

- [ ] **Step 1: Write the DTOs**

`src/products/dto/presign-image.dto.ts`:
```ts
import { IsIn, IsString } from 'class-validator';

export class PresignImageDto {
  @IsString()
  @IsIn(['image/jpeg', 'image/png', 'image/webp'])
  contentType!: string;
}
```

`src/products/dto/confirm-image.dto.ts`:
```ts
import { IsNotEmpty, IsString } from 'class-validator';

export class ConfirmImageDto {
  @IsString()
  @IsNotEmpty()
  key!: string;
}
```

- [ ] **Step 2: Write the failing unit tests** (extend `src/products/products.service.spec.ts`)

Add a `storage` mock to the existing `beforeEach` and pass it as the 5th constructor arg:
```ts
  storage = {
    putObject: jest.fn().mockResolvedValue(undefined),
    presignPutUrl: jest.fn().mockResolvedValue('https://minio/presigned-put'),
    presignGetUrl: jest.fn().mockResolvedValue('https://minio/presigned-get'),
    objectExists: jest.fn().mockResolvedValue(true),
    deleteObject: jest.fn().mockResolvedValue(undefined),
  };
  service = new ProductsService(prisma, ownership, categories, brands, storage as any);
```
Then add:
```ts
  const productId = '33333333-3333-3333-3333-333333333333';
  const owner = { id: 'owner-1', companyId: 'company-1', roleId: 2, roleCode: 'OWNER', status: 'ACTIVE' } as any;

  it('uploadImage stores the file under products/<id>/<uuid>.<ext>, deletes the old, sets imageUrl', async () => {
    prisma.product.findFirst.mockResolvedValue({ id: productId, companyId: 'company-1', imageUrl: 'products/old.jpg' });
    prisma.product.update.mockResolvedValue({ id: productId, imageUrl: 'k' });

    await service.uploadImage(owner, productId, { buffer: Buffer.from('x'), mimetype: 'image/png' } as any);

    const putKey = storage.putObject.mock.calls[0][0];
    expect(putKey).toMatch(new RegExp(`^products/${productId}/[0-9a-f-]+\\.png$`));
    expect(storage.deleteObject).toHaveBeenCalledWith('products/old.jpg'); // old removed
    expect(prisma.product.update).toHaveBeenCalledWith({
      where: { id: productId },
      data: { imageUrl: putKey },
    });
  });

  it('presignImageUpload returns an upload URL + key without touching the product', async () => {
    prisma.product.findFirst.mockResolvedValue({ id: productId, companyId: 'company-1', imageUrl: null });

    const res = await service.presignImageUpload(owner, productId, { contentType: 'image/jpeg' } as any);

    expect(res.key).toMatch(new RegExp(`^products/${productId}/[0-9a-f-]+\\.jpg$`));
    expect(res.uploadUrl).toBe('https://minio/presigned-put');
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  it('confirmImage rejects a key that is not under this product (400)', async () => {
    prisma.product.findFirst.mockResolvedValue({ id: productId, companyId: 'company-1', imageUrl: null });
    await expect(
      service.confirmImage(owner, productId, { key: 'products/other/x.jpg' } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('confirmImage rejects a key whose object is missing (400)', async () => {
    prisma.product.findFirst.mockResolvedValue({ id: productId, companyId: 'company-1', imageUrl: null });
    storage.objectExists.mockResolvedValue(false);
    await expect(
      service.confirmImage(owner, productId, { key: `products/${productId}/x.jpg` } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('findOne presents the stored key as a presigned URL', async () => {
    prisma.product.findFirst.mockResolvedValue({ id: productId, companyId: 'company-1', imageUrl: 'products/k.jpg' });
    const res = await service.findOne(owner, productId);
    expect(res.imageUrl).toBe('https://minio/presigned-get');
    expect(storage.presignGetUrl).toHaveBeenCalledWith('products/k.jpg');
  });
```
(Ensure `BadRequestException` is imported in the spec.)

- [ ] **Step 3: Run — verify they fail**

Run: `npm test -- products.service`
Expected: FAIL — `service.uploadImage is not a function` (and the constructor-arity mismatch).

- [ ] **Step 4: Update `src/products/products.service.ts`**

Add imports:
```ts
import { randomUUID } from 'crypto';
import { StorageService } from '../storage/storage.service';
import { PresignImageDto } from './dto/presign-image.dto';
import { ConfirmImageDto } from './dto/confirm-image.dto';

const IMAGE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
```
Add `storage` to the constructor:
```ts
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
    private readonly categories: CategoriesService,
    private readonly brands: BrandsService,
    private readonly storage: StorageService,
  ) {}
```
Add the helpers and split raw vs presented reads:
```ts
  private imageKey(productId: string, contentType: string): string {
    const ext = IMAGE_EXT[contentType] ?? 'bin';
    return `products/${productId}/${randomUUID()}.${ext}`;
  }

  private async present<T extends { imageUrl: string | null }>(
    product: T,
  ): Promise<T> {
    if (!product.imageUrl) return product;
    return { ...product, imageUrl: await this.storage.presignGetUrl(product.imageUrl) };
  }

  private async findOneRaw(caller: AuthUser, id: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, ...this.ownership.scopeToCompany(caller), deletedAt: null },
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }
```
Rewrite `findAll`/`findOne` to present, and point `update`/`remove` at `findOneRaw`:
```ts
  async findAll(caller: AuthUser) {
    const products = await this.prisma.product.findMany({
      where: { ...this.ownership.scopeToCompany(caller), deletedAt: null },
    });
    return Promise.all(products.map((p) => this.present(p)));
  }

  async findOne(caller: AuthUser, id: string) {
    return this.present(await this.findOneRaw(caller, id));
  }
```
(In `update` and `remove`, change `await this.findOne(caller, id)` → `await this.findOneRaw(caller, id)` — identical behavior, avoids a wasted presign.)

Add the three image methods:
```ts
  async uploadImage(
    caller: AuthUser,
    id: string,
    file: Express.Multer.File,
  ) {
    const product = await this.findOneRaw(caller, id);
    const key = this.imageKey(id, file.mimetype);
    await this.storage.putObject(key, file.buffer, file.mimetype);
    if (product.imageUrl) await this.storage.deleteObject(product.imageUrl);
    const updated = await this.prisma.product.update({
      where: { id },
      data: { imageUrl: key },
    });
    return this.present(updated);
  }

  async presignImageUpload(
    caller: AuthUser,
    id: string,
    dto: PresignImageDto,
  ) {
    await this.findOneRaw(caller, id);
    const key = this.imageKey(id, dto.contentType);
    const uploadUrl = await this.storage.presignPutUrl(key, dto.contentType);
    return { uploadUrl, key };
  }

  async confirmImage(caller: AuthUser, id: string, dto: ConfirmImageDto) {
    const product = await this.findOneRaw(caller, id);
    if (!dto.key.startsWith(`products/${id}/`))
      throw new BadRequestException('Key does not belong to this product');
    if (!(await this.storage.objectExists(dto.key)))
      throw new BadRequestException('Uploaded object not found');
    if (product.imageUrl) await this.storage.deleteObject(product.imageUrl);
    const updated = await this.prisma.product.update({
      where: { id },
      data: { imageUrl: dto.key },
    });
    return this.present(updated);
  }
```

- [ ] **Step 5: Add the routes to `src/products/products.controller.ts`**

Imports:
```ts
import {
  Body,
  FileTypeValidator,
  MaxFileSizeValidator,
  ParseFilePipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { PresignImageDto } from './dto/presign-image.dto';
import { ConfirmImageDto } from './dto/confirm-image.dto';
```
Routes (match the existing controller's id-param pipe — products use `ParseUUIDPipe`):
```ts
  @RequirePermissions('products.update')
  @Post(':id/image')
  @UseInterceptors(FileInterceptor('file'))
  uploadImage(
    @CurrentUser() caller: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 5 * 1024 * 1024 }),
          new FileTypeValidator({ fileType: /^image\/(jpeg|png|webp)$/ }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.products.uploadImage(caller, id, file);
  }

  @RequirePermissions('products.update')
  @Post(':id/image/presign')
  presignImage(
    @CurrentUser() caller: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PresignImageDto,
  ) {
    return this.products.presignImageUpload(caller, id, dto);
  }

  @RequirePermissions('products.update')
  @Post(':id/image/confirm')
  confirmImage(
    @CurrentUser() caller: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmImageDto,
  ) {
    return this.products.confirmImage(caller, id, dto);
  }
```

- [ ] **Step 6: Run the unit tests — all green**

Run: `npm test -- products.service`
Expected: PASS (existing product tests + the 5 new image tests).

- [ ] **Step 7: Build + full suite**

Run: `npm run build` → exits 0.
Run: `npm test` → all suites green.

- [ ] **Step 8: Commit**

```bash
git add src/products/dto src/products/products.service.ts src/products/products.controller.ts src/products/products.service.spec.ts
git commit -m "feat(products): image upload (proxied + presigned) + presign-on-read via StorageService"
```

---

## Task 3: e2e — the product-image flow (human runs, MinIO up)

**Files:**
- Create: `test/uploads.e2e-spec.ts`

**Interfaces:**
- Consumes: the running app + MinIO (`inventra-files-test` bucket) + seeded permissions.

- [ ] **Step 1: Write the e2e** (reuse `registerCompany`/`registerMember` shape from another e2e; distinct `@upl.test` / `1x0-…` ids. Setup: an owner + a category (ADMIN) + a brand (owner) + a product (owner).)

`test/uploads.e2e-spec.ts`:
```ts
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('File Uploads — product image (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: any;

  let adminAccess: string;
  let ownerAccess: string;
  let productId: string;

  const auth = (token: string): [string, string] => [
    'Authorization',
    `Bearer ${token}`,
  ];

  // a 1x1 PNG
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    http = app.getHttpServer();

    adminAccess = (
      await request(http)
        .post('/auth/login')
        .send({ email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD })
        .expect(201)
    ).body.accessToken;

    const taxId = '110-00-00001';
    const email = 'owner1@upl.test';
    const password = 'password123';
    await request(http)
      .post('/auth/register')
      .send({ companyName: 'UPL Co', taxId, ownerName: 'Owner', ownerEmail: email, ownerPassword: password })
      .expect(201);
    const company = await prisma.company.findUnique({ where: { taxId } });
    await request(http).patch(`/companies/${company!.id}/approve`).set(...auth(adminAccess)).expect(200);
    ownerAccess = (await request(http).post('/auth/login').send({ email, password }).expect(201)).body.accessToken;

    const categoryId = (
      await request(http).post('/categories').set(...auth(adminAccess)).send({ name: 'UPL Cat' }).expect(201)
    ).body.id;
    const brandId = (
      await request(http).post('/brands').set(...auth(ownerAccess)).send({ name: 'UPL Brand' }).expect(201)
    ).body.id;
    productId = (
      await request(http)
        .post('/products')
        .set(...auth(ownerAccess))
        .send({ name: 'UPL P1', barcode: 'UPL-BC-1', categoryId, brandId, priceKrw: 1000 })
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

    const read = await request(http).get(`/products/${productId}`).set(...auth(ownerAccess)).expect(200);
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

    // upload the bytes DIRECTLY to MinIO using the presigned PUT URL (not supertest)
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
});
```

- [ ] **Step 2: Run the e2e** — with MinIO up (`docker compose up -d`), `npm run test:e2e`. *(Developer runs.)*
Expected: the uploads suite green (plus all existing suites).

- [ ] **Step 3: Commit**

```bash
git add test/uploads.e2e-spec.ts
git commit -m "test(uploads): e2e product image — proxied, presigned round-trip, presign-on-read, 400s"
```

---

## Self-Review (spec coverage)

- Spec §2 decisions (MinIO/S3 SDK, drop multer-s3, private + presign-on-read, both flows, sliced) → Tasks 1–2. ✓
- §3 infra (docker MinIO + env) → Task 1 Steps 2–4. ✓
- §4 `StorageService` (5 primitives + bucket ensure) → Task 1 Step 5. ✓
- §5 keys/content-types → Task 2 `imageKey` + `IMAGE_EXT`. ✓
- §6 product-image API (both flows, authz via `products.update` + ownership) → Task 2. ✓
- §7 presign-on-read → Task 2 `present()` in `findOne`/`findAll` + image returns. ✓
- §8 errors (400 type/size/key, 403 perms/ownership, 404 product) → Task 2 (400/404) + RBAC (403); e2e Task 3. ✓
- §9 testing (unit with mocked storage; e2e vs MinIO) → Task 2 + Task 3. ✓
- §10 out-of-scope (other entities, public option, resizing) → nothing implements them. ✓
- Type consistency: `StorageService` method names identical across Task 1 def, Task 2 calls, and the spec mock; `imageKey`/`present`/`findOneRaw` consistent; `uploadImage`/`presignImageUpload`/`confirmImage` signatures match controller + tests. ✓
