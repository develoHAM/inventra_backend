/*
  Warnings:

  - You are about to drop the column `company_store_id` on the `profiles` table. All the data in the column will be lost.

*/
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "membership_change_reason" ADD VALUE 'BRANCH_ADDED';
ALTER TYPE "membership_change_reason" ADD VALUE 'BRANCH_REMOVED';
ALTER TYPE "membership_change_reason" ADD VALUE 'LEFT_COMPANY';
ALTER TYPE "membership_change_reason" ADD VALUE 'REMOVED';
ALTER TYPE "membership_change_reason" ADD VALUE 'ACCOUNT_DELETED';
ALTER TYPE "membership_change_reason" ADD VALUE 'COMPANY_CLOSED';
ALTER TYPE "membership_change_reason" ADD VALUE 'AUTO_PROMOTED';

-- AlterEnum
ALTER TYPE "phone_verification_purpose" ADD VALUE 'DELETE_ACCOUNT';

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "deleted_by_profile_id" UUID;

-- CreateTable
CREATE TABLE "profile_branches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "profile_id" UUID NOT NULL,
    "company_store_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by_profile_id" UUID,

    CONSTRAINT "profile_branches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IDX_profile_branches_branch" ON "profile_branches"("company_store_id");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_profile_branches_profile_branch" ON "profile_branches"("profile_id", "company_store_id") WHERE (deleted_at IS NULL);

-- Copy (hand-written, before anything applies this migration): each
-- non-deleted profile's branch, if it's a live branch, becomes its first
-- assignment. id, created_at and updated_at come from the column defaults.
-- Roles aren't touched. It runs before the column below is dropped.
INSERT INTO "profile_branches" ("profile_id", "company_store_id")
SELECT p."id", p."company_store_id"
FROM "profiles" p
JOIN "company_stores" cs ON cs."id" = p."company_store_id"
WHERE p."deleted_at" IS NULL AND cs."deleted_at" IS NULL;

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_deleted_by_profile_id_fkey" FOREIGN KEY ("deleted_by_profile_id") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_branches" ADD CONSTRAINT "profile_branches_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_branches" ADD CONSTRAINT "profile_branches_company_store_id_fkey" FOREIGN KEY ("company_store_id") REFERENCES "company_stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_branches" ADD CONSTRAINT "profile_branches_deleted_by_profile_id_fkey" FOREIGN KEY ("deleted_by_profile_id") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Moved to the end by hand: the old column goes only after the copy above.
-- DropForeignKey
ALTER TABLE "profiles" DROP CONSTRAINT "profiles_company_store_id_fkey";

-- AlterTable
ALTER TABLE "profiles" DROP COLUMN "company_store_id";
