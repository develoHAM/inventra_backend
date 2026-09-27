/*
  Warnings:

  - A unique constraint covering the columns `[phone]` on the table `users` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "phone_verification_purpose" AS ENUM ('SIGNUP', 'FIND_ID', 'RESET_PASSWORD');

-- CreateTable
CREATE TABLE "phone_verifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "phone" VARCHAR(20) NOT NULL,
    "purpose" "phone_verification_purpose" NOT NULL,
    "code" VARCHAR(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "check_attempts" INTEGER NOT NULL DEFAULT 0,
    "verified_at" TIMESTAMPTZ(6),
    "token_hash" VARCHAR(64),
    "token_expires_at" TIMESTAMPTZ(6),
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "phone_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UQ_phone_verifications_token_hash" ON "phone_verifications"("token_hash");

-- CreateIndex
CREATE INDEX "IDX_phone_verifications_phone_created" ON "phone_verifications"("phone", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_users_phone" ON "users"("phone");
