-- The sign-in moves off "users" onto a new "accounts" table: phone, login
-- methods, sessions (refresh tokens) and devices. "users" stays as the
-- company profile.
--
-- Hand-ordered so no data is lost (Prisma's generated version dropped
-- users.phone and the user_id columns before anything could copy them):
--   1. expand   — the new table, and the new columns as NULLABLE
--   2. copy     — one account per existing user, then point everything at it
--   3. contract — the new columns become NOT NULL; the old columns go
--   4. the new indexes and foreign keys, as Prisma generated them
-- Every migrated account REUSES its user's id, so each copy is a plain
-- column-to-column copy. Accounts created later get fresh ids.

-- 1. Expand ------------------------------------------------------------------

CREATE TABLE "accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "phone" VARCHAR(20),
    "last_profile_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "users" ADD COLUMN "account_id" UUID;
ALTER TABLE "user_login_methods" ADD COLUMN "account_id" UUID;
ALTER TABLE "refresh_tokens" ADD COLUMN "account_id" UUID,
ADD COLUMN "profile_id" UUID;
ALTER TABLE "device_tokens" ADD COLUMN "account_id" UUID;

-- 2. Copy --------------------------------------------------------------------

-- One account per user, same id. A deleted user's account is deleted too,
-- so its phone is free for a new signup. The user's profile is the one
-- their account opens at sign-in.
INSERT INTO "accounts" ("id", "phone", "last_profile_id", "created_at", "updated_at", "deleted_at")
  SELECT "id", "phone", "id", "created_at", "updated_at", "deleted_at" FROM "users";

UPDATE "users"              SET "account_id" = "id";
UPDATE "user_login_methods" SET "account_id" = "user_id";
-- an existing session keeps its profile open
UPDATE "refresh_tokens"     SET "account_id" = "user_id", "profile_id" = "user_id";
UPDATE "device_tokens"      SET "account_id" = "user_id";

-- 3. Contract ----------------------------------------------------------------

ALTER TABLE "users" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "user_login_methods" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "refresh_tokens" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "device_tokens" ALTER COLUMN "account_id" SET NOT NULL;

-- DropForeignKey
ALTER TABLE "device_tokens" DROP CONSTRAINT "device_tokens_user_id_fkey";

-- DropForeignKey
ALTER TABLE "refresh_tokens" DROP CONSTRAINT "refresh_tokens_user_id_fkey";

-- DropForeignKey
ALTER TABLE "user_login_methods" DROP CONSTRAINT "user_login_methods_user_id_fkey";

-- DropIndex
DROP INDEX "IDX_device_tokens_user";

-- DropIndex
DROP INDEX "IDX_refresh_tokens_user_id";

-- DropIndex
DROP INDEX "UQ_login_methods_user_method";

-- DropIndex
DROP INDEX "UQ_users_phone";

ALTER TABLE "device_tokens" DROP COLUMN "user_id";
ALTER TABLE "refresh_tokens" DROP COLUMN "user_id";
ALTER TABLE "user_login_methods" DROP COLUMN "user_id";
ALTER TABLE "users" DROP COLUMN "phone";

-- 4. New indexes and foreign keys -------------------------------------------

-- CreateIndex
CREATE UNIQUE INDEX "UQ_accounts_phone" ON "accounts"("phone") WHERE (deleted_at IS NULL);

-- CreateIndex
CREATE INDEX "IDX_device_tokens_account" ON "device_tokens"("account_id");

-- CreateIndex
CREATE INDEX "IDX_refresh_tokens_account_id" ON "refresh_tokens"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_login_methods_account_method" ON "user_login_methods"("account_id", "method");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_users_account_company" ON "users"("account_id", "company_id") WHERE ((deleted_at IS NULL) AND (status <> 'DEACTIVATED'::user_status));

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_last_profile_id_fkey" FOREIGN KEY ("last_profile_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_login_methods" ADD CONSTRAINT "user_login_methods_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
