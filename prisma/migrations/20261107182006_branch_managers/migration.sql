/*
  Warnings:

  - You are about to drop the column `manager_user_id` on the `company_stores` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "company_stores" DROP CONSTRAINT "company_stores_manager_user_id_fkey";

-- AlterTable
ALTER TABLE "company_stores" DROP COLUMN "manager_user_id";
