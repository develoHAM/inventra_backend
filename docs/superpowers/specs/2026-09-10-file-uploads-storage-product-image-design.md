# File Uploads — Slice 1: Storage Foundation & Product Image — Design

> Inventra file-upload subsystem, Slice 1 of 3. Build the shared storage layer (MinIO/S3 via `StorageService`) end-to-end on one field — `product.imageUrl` — supporting **both** upload flows (proxied + presigned), a **private** bucket, and **presign-on-read**. Slices 2 (brand logo, user avatar) and 3 (order/audit files) reuse this foundation.

## 1. Goal & scope

Files are stored in **S3-compatible object storage** — **MinIO** locally (a container in `docker-compose`), swappable to real S3/Cloudflare R2 in production by env alone. All objects are **private**; the DB stores an **object key**, and reads return a short-lived **presigned GET URL** so nothing is publicly reachable.

**This slice delivers:** the `StorageService` (the S3 wrapper), MinIO infra + env, and product-image upload on `product.imageUrl` via both flows, plus presign-on-read for products. **Later slices reuse `StorageService` unchanged.**

## 2. Decisions (settled in brainstorming)

1. **MinIO / S3-compatible, via `@aws-sdk/client-s3`.** MinIO is the server (Docker); our code talks to it with the standard AWS S3 SDK (not the `minio` client) so the prod swap to S3/R2 is env-only. `forcePathStyle: true` + a configured `endpoint` are the only MinIO-specific client settings.
2. **Drop `multer-s3`; use a `StorageService`.** Multer (via `@nestjs/platform-express`'s `FileInterceptor`) receives the proxied upload as a `Buffer` (memory storage); `StorageService` does all S3 operations. This centralizes uploads **plus** presigned URLs **plus** delete, which `multer-s3` can't do.
3. **Private bucket, presign-on-read.** One private bucket; the DB column stores the **key**, and every read swaps the key → a presigned GET URL (signed locally, no network call). A public path can be added later without disruption.
4. **Both flows offered per field.** Proxied (bytes through the API, server-validated) and presigned (bytes client→S3 directly, three-step). The client picks.
5. **Sliced rollout.** Slice 1 = foundation + product image; 2 = brand logo + user avatar; 3 = order/audit files (+ the audit-frozen guard).

## 3. Infrastructure

### 3a. MinIO in `docker-compose.yml`
Add alongside `postgres`/`redis` (env-interpolated, like the others):
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
      - '${MINIO_PORT}:9000'          # S3 API
      - '${MINIO_CONSOLE_PORT}:9001'  # web console (browse objects)
    volumes:
      - inventra_miniodata:/data
    healthcheck:
      test: ['CMD', 'mc', 'ready', 'local']
      interval: 5s
      timeout: 5s
      retries: 5
```
plus `inventra_miniodata:` under `volumes:`. The web console at `:9001` (login = the root user/pass) lets you *see* uploaded objects — useful while learning.

### 3b. Env (`src/config/env.schema.ts`) — new `-- Storage (S3 / MinIO) --` section
```ts
  // -- Storage (S3 / MinIO) --
  S3_ENDPOINT: z.string().url(),                 // http://localhost:9000 (dev)
  S3_REGION: z.string().default('us-east-1'),    // dummy for MinIO; real region in prod
  S3_ACCESS_KEY: z.string().min(1),              // = MINIO_ROOT_USER in dev
  S3_SECRET_KEY: z.string().min(1),              // = MINIO_ROOT_PASSWORD in dev
  S3_BUCKET: z.string().min(1),                  // inventra-files (dev) / inventra-files-test (test)
  S3_PRESIGN_EXPIRY_SECONDS: z.coerce.number().int().positive().default(300),
```
The docker-compose vars (`MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `MINIO_PORT`, `MINIO_CONSOLE_PORT`) live in the root `.env` (not validated by the app's Zod — they're for compose); the app-facing `S3_*` vars go in `.env` **and** `.env.test`. Dev and test point at the same MinIO but **different buckets** (`inventra-files` vs `inventra-files-test`).

## 4. `StorageModule` / `StorageService`

`StorageModule` is **`@Global()`** (like `PrismaModule`), providing + exporting `StorageService`, so every entity module can inject it without re-importing.

```ts
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly presignExpiry: number;

  constructor(config: ConfigService<Env, true>) {
    this.client = new S3Client({
      endpoint: config.get('S3_ENDPOINT', { infer: true }),
      region: config.get('S3_REGION', { infer: true }),
      forcePathStyle: true,                          // MinIO path-style addressing
      credentials: {
        accessKeyId: config.get('S3_ACCESS_KEY', { infer: true }),
        secretAccessKey: config.get('S3_SECRET_KEY', { infer: true }),
      },
    });
    this.bucket = config.get('S3_BUCKET', { infer: true });
    this.presignExpiry = config.get('S3_PRESIGN_EXPIRY_SECONDS', { infer: true });
  }

  // Ensure the bucket exists on boot (HeadBucket → CreateBucket on 404),
  // so dev/test setup needs no manual bucket creation.
  async onModuleInit(): Promise<void> { /* … */ }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void>;   // PutObjectCommand
  async presignPutUrl(key: string, contentType: string): Promise<string>;           // getSignedUrl(PutObjectCommand)
  async presignGetUrl(key: string): Promise<string>;                                // getSignedUrl(GetObjectCommand)
  async objectExists(key: string): Promise<boolean>;                                // HeadObjectCommand, false on 404
  async deleteObject(key: string): Promise<void>;                                   // DeleteObjectCommand
}
```

Uses `@aws-sdk/client-s3` (commands + client) and `@aws-sdk/s3-request-presigner` (`getSignedUrl`). All presigned URLs use `presignExpiry`. `StorageService` knows **nothing** about products — it's a generic key/bytes API.

## 5. Object keys & content types

- **Key scheme:** `products/{productId}/{uuid}.{ext}` — `crypto.randomUUID()` for the uuid; `ext` derived from the MIME type (`image/jpeg → jpg`, `image/png → png`, `image/webp → webp`). The `/`s are just string structure, not folders.
- **Allowed image types (this slice):** `image/jpeg`, `image/png`, `image/webp`. **Max size:** 5 MB.
- A small `imageExtFor(mime)` map lives with the product-image code (a shared `Uploadable` config emerges in Slice 2 if the repetition is real — not abstracted prematurely here).

## 6. Product-image API (both flows)

Three routes on `ProductsController`, all `@RequirePermissions('products.update')` + the product's existing company-ownership (reuse `ProductsService`'s lookup). Logic lives in `ProductsService` (it already owns the product row + ownership); the controller stays thin.

| Method | Path | Body | Purpose |
|--------|------|------|---------|
| POST | `/products/:id/image` | multipart `file` | **Proxied** upload |
| POST | `/products/:id/image/presign` | `{ contentType }` | Get a **presigned PUT** URL |
| POST | `/products/:id/image/confirm` | `{ key }` | Record a completed presigned upload |

- **Proxied** — `@UseInterceptors(FileInterceptor('file'))` + `@UploadedFile(new ParseFilePipe({ validators: [ new FileTypeValidator({ fileType: /^image\/(jpeg|png|webp)$/ }), new MaxFileSizeValidator({ maxSize: 5 * 1024 * 1024 }) ] }))`. Service: load+authorize the product → build a key → `putObject` → delete the previous object if the product already had a key → set `imageUrl = key` → return the product (presigned-on-read).
- **Presign** — validate `contentType` is an allowed image type (DTO) → build a key → `presignPutUrl(key, contentType)` → return `{ uploadUrl, key }`. *Does not* change the product yet. (Contract: the client must `PUT` with that exact `Content-Type`. Size can't be hard-enforced on a presigned PUT — a documented limitation of Flow B.)
- **Confirm** — validate the `key` belongs to this product (must start with `products/{id}/`) → `objectExists(key)` (else 400) → delete the previous object → set `imageUrl = key` → return the product.

## 7. Presign-on-read (products)

`ProductsService.findOne` / `findAll` (and the three image endpoints' return values) map the stored `imageUrl` **key** → a presigned GET URL before returning:
```ts
private async present<T extends { imageUrl: string | null }>(product: T): Promise<T> {
  return { ...product, imageUrl: product.imageUrl ? await this.storage.presignGetUrl(product.imageUrl) : null };
}
```
`findAll` maps the list (presigning is local/CPU-only, so mapping many is cheap). A `null` `imageUrl` stays `null`. The DB always holds the key; the client always receives a short-lived URL (or `null`).

## 8. Validation & errors

| Situation | Status |
|-----------|--------|
| Proxied: wrong MIME or > 5 MB | 400 (`ParseFilePipe`) |
| Presign: `contentType` not an allowed image type | 400 |
| Confirm: `key` not under `products/{id}/`, or object doesn't exist in the bucket | 400 |
| Caller lacks `products.update` | 403 |
| Product not the caller's tenant | 403 / 404 (existing product ownership) |
| Product absent / soft-deleted | 404 |

## 9. Testing

- **Unit** — `products.service.spec.ts` extended (mock `StorageService` + Prisma): proxied upload builds the `products/{id}/{uuid}.ext` key, calls `putObject`, deletes the old key when replacing, sets `imageUrl`; confirm rejects a foreign key prefix (400) and a missing object (400); presign returns `{ uploadUrl, key }` without touching the product; `present()` maps a key → presigned URL and passes `null` through. `StorageService` itself is a thin SDK wrapper — exercised for real by the e2e against MinIO rather than unit-mocked.
- **e2e** — `test/uploads.e2e-spec.ts` (developer runs; **requires MinIO up** — `docker compose up -d` now starts it; uses the `inventra-files-test` bucket). Proxied: create a product, `POST /products/:id/image` with `.attach('file', buffer, 'x.png')` → 201/200, response `imageUrl` is a presigned URL, and a follow-up `GET /products/:id` still returns a (fresh) presigned `imageUrl`. Presigned: `…/image/presign` → `PUT` the bytes to the returned `uploadUrl` (via `fetch`, directly to MinIO, not supertest) → `…/image/confirm { key }` → `imageUrl` set. Rejections: non-image 400, foreign-key confirm 400. Leftover test objects are harmless (no bucket reset; optional cleanup).

## 10. Out of scope (this slice)

- Brand logo, user avatar (Slice 2); order/audit files + the audit-frozen guard (Slice 3).
- The public-bucket option (deferred; the design leaves room for it).
- Image resizing / optimization (`sharp`), virus scanning, CDN, multi-image galleries.
- Hard size enforcement on the presigned-PUT flow (a documented Flow-B limitation).
