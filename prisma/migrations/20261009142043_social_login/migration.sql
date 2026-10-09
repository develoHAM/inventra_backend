/*
  Warnings:

  - A unique constraint covering the columns `[method,provider_user_id]` on the table `user_login_methods` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[user_id,method]` on the table `user_login_methods` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "redacted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "contact_email" VARCHAR(255);

-- CreateTable
CREATE TABLE "social_signup_tickets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "token_hash" VARCHAR(64) NOT NULL,
    "provider" VARCHAR(20) NOT NULL,
    "provider_user_id" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255),
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "name" VARCHAR(100),
    "provider_refresh_token" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_signup_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_nonces" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "nonce_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_nonces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" VARCHAR(255) NOT NULL,
    "code_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "verified_at" TIMESTAMPTZ(6),
    "token_hash" VARCHAR(64),
    "token_expires_at" TIMESTAMPTZ(6),
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UQ_social_signup_tickets_token_hash" ON "social_signup_tickets"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_social_nonces_nonce_hash" ON "social_nonces"("nonce_hash");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_email_verifications_token_hash" ON "email_verifications"("token_hash");

-- CreateIndex
CREATE INDEX "IDX_email_verifications_email_created" ON "email_verifications"("email", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_login_methods_identity" ON "user_login_methods"("method", "provider_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_login_methods_user_method" ON "user_login_methods"("user_id", "method");

-- Backfill (hand-written): existing accounts keep receiving notifications at
-- their login email. Social-only accounts created later set contact_email at signup.
UPDATE "users" u
SET "contact_email" = lm."email"
FROM "user_login_methods" lm
WHERE lm."user_id" = u."id"
  AND lm."method" = 'local'
  AND lm."email" IS NOT NULL;
