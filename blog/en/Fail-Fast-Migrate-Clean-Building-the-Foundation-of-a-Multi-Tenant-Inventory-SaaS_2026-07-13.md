# Fail Fast, Migrate Clean: Building the Foundation of a Multi-Tenant Inventory SaaS

*Phase 0 of building Inventra — the infrastructure, config, and database groundwork that everything else stands on.*

**2026-07-13**

---

I'm building **Inventra**, a multi-tenant inventory-management SaaS modeled on the Korean concession-store business: companies and brands operate "corners" inside physical stores (think 교보문고 강남점), each tracking its own stock. The stack is **NestJS, Prisma, and PostgreSQL**, with Redis planned for later.

Before writing a single feature, I wanted a foundation that was **reproducible, fail-fast, and type-safe**. This is Phase 0 — Docker, validated config, and the database — and the decisions (and mistakes) that shaped it.

## Architectural decisions

### 1. Docker Compose for Postgres + Redis

- **Goal:** a database and cache that run identically on my machine and anyone else's, with zero "works on my machine."
- **Options:** install Postgres/Redis natively on macOS, or run them as containers via Docker Compose.
- **Choice:** Docker Compose.
- **Reason:** one `docker-compose.yml` describes the exact versions, ports, volumes, and health checks. `docker compose up -d` reproduces the whole environment; named volumes keep the data across restarts.
- **Result:** a committed, shareable environment. A teammate clones the repo and gets an identical Postgres 17 + Redis 8 in seconds.

### 2. Zod (not Joi) for environment validation

- **Goal:** the app should refuse to boot if a required env var is missing or malformed — loudly, at startup, not at 2 a.m. on a random code path.
- **Options:** Joi (the `@nestjs/config` docs' default) or Zod.
- **Choice:** Zod, wired into `ConfigModule.forRoot`'s generic `validate` function.
- **Reason:** Zod is TypeScript-first — one schema gives me **both** runtime validation **and** a static type (`z.infer`). With Joi I'd validate at runtime and *separately* hand-write the config type, and the two would drift. Zod keeps them in sync from a single source.
- **Result:** `config.get('PORT', { infer: true })` returns a real `number`, and a missing `DATABASE_URL` aborts boot with a readable error. Fail-fast, type-safe config.

### 3. Prisma schema as the source of truth (authored, not introspected)

- **Goal:** own the database schema in one place and evolve it through versioned migrations.
- **Options:** introspect an existing SQL DDL into Prisma, or author `schema.prisma` by hand and let Prisma generate migrations.
- **Choice:** author it.
- **Reason:** I wanted Prisma to be the single source of truth going forward, with a clean migration history — not a messy introspected baseline.
- **Result:** 19 models across domain-split files, including the clever bit — **composite foreign keys that enforce tenant isolation**. A line item's product and its parent order share a `company_store_id` column across two FKs, so the database makes it *structurally impossible* to mix corners. A few things Prisma can't express (a `CHECK` constraint, and my preference on identity columns) I handled by generating the migration with `--create-only` and hand-editing the SQL before applying.

### 4. Prisma 7's driver adapter, wired through NestJS DI

- **Goal:** a single, shared, lifecycle-managed database connection.
- **Options:** `new PrismaClient()` wherever needed, or one injectable `PrismaService`.
- **Choice:** a `PrismaService` that extends `PrismaClient`, provided globally.
- **Reason:** one connection pool, one place to manage connect/disconnect, and a mockable seam for tests. Prisma 7 also *requires* a driver adapter now, so the service builds a `PrismaPg` adapter from the validated `DATABASE_URL` and passes it to `super()`.
- **Result:** any service injects `PrismaService` and calls `this.user.findMany()` directly, backed by one pool that connects on boot and disconnects on shutdown.

## Today I Learned

**Q: When I quit Docker Desktop, why did every `docker` command break?**
Because Docker on macOS runs a Linux VM with a background **daemon** (`dockerd`) inside it, and that daemon is what actually runs containers. The `docker` CLI is just a client that sends it requests. Quitting Docker Desktop kills the daemon — so the CLI has nothing to talk to. It's a remote for a TV that's unplugged.

**Q: What's the difference between a Dockerfile and docker-compose?**
A **Dockerfile** is a recipe to build *one* image. **docker-compose** orchestrates *multiple* containers together (mine runs prebuilt Postgres and Redis images, so no Dockerfile needed). Dockerfile builds a box; Compose runs a set of boxes.

**Q: My build said "Found 0 errors" but then crashed with "Cannot find module dist/main." How?**
A stale TypeScript incremental cache. `deleteOutDir` wiped `dist/`, but the `.tsbuildinfo` cache (sitting at the project root) still claimed everything was compiled — so tsc emitted *nothing*. The fix: relocate the cache **inside** `dist` via `tsBuildInfoFile`, so deleting `dist` deletes the cache too and they can never drift.

**Q: Why does `company_store_products` have a `@@unique([id, companyStoreId])` when `id` is already unique?**
Because a foreign key can only point at a **unique constraint**, and I need child tables to reference the *pair* `(id, company_store_id)` — not just `id`. That "redundant" unique exists purely to be a legal FK target, which is what lets the database guarantee a product and its order belong to the same corner.

**Q: `sslmode=require` broke my local connection with a TLS error. Why?**
That parameter forces an encrypted connection, but my local Postgres container serves no TLS. `sslmode=require` belongs in *production* (managed databases require it); locally I dropped it. A textbook don't-ship-prod-config-locally lesson.

**Q: Why did Prisma 7 refuse to connect without an "adapter"?**
Prisma 7 dropped the bundled query engine in favor of **driver adapters** — it runs its query logic in JS and delegates the actual connection to a standard driver (`pg` via `PrismaPg`). So the client no longer reads `DATABASE_URL` magically; you construct an adapter and hand it in. More explicit, but you must wire it up.

## NestJS concepts & libraries used

| Thing | Why |
|---|---|
| `@nestjs/config` + `ConfigService` | Load and expose validated config through DI. |
| **Dependency Injection** | Classes declare what they need in the constructor; Nest supplies shared singletons — testable, decoupled. |
| **Modules** (`@Module`, `@Global`) | Group and share providers; `PrismaModule` is global so every feature can inject the DB. |
| **Lifecycle hooks** (`OnModuleInit`/`OnModuleDestroy`) | Open the DB connection at startup, close it on graceful shutdown. |
| **Zod** | One schema → runtime validation + static types for env config. |
| **Prisma 7** + `@prisma/adapter-pg` | Type-safe data access; the pg driver adapter provides the connection. |

## Wrap-up

Phase 0 delivered the spine of the project: a reproducible Dockerized database, config that fails fast and stays typed, a 19-table schema with database-enforced tenant isolation, and a NestJS-integrated Prisma client that connects on boot. None of it is a "feature" a user sees — but every feature will lean on it.

**Next up — Phase 1:** authentication and authorization. JWT access/refresh tokens, a custom guard pipeline, and a role-based permission system with per-user grant/deny overrides. That's where the NestJS request lifecycle really comes alive.
