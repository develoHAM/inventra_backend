/*
  Warnings:

  - A unique constraint covering the columns `[join_code]` on the table `companies` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `join_code` to the `companies` table without a default value. This is not possible if the table is not empty.
  - Made the column `tax_id` on table `companies` required. This step will fail if there are existing NULL values in that column.
  - Added the required column `name` to the `users` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "users" DROP CONSTRAINT "users_role_id_fkey";

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "join_code" VARCHAR(30) NOT NULL,
ALTER COLUMN "tax_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "name" VARCHAR(100) NOT NULL,
ALTER COLUMN "role_id" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "UQ_companies_join_code" ON "companies"("join_code");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
