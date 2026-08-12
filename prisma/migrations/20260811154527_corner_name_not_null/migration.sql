/*
  Warnings:

  - Made the column `name` on table `company_stores` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "company_stores" ALTER COLUMN "name" SET NOT NULL;
