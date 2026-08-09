/*
  Warnings:

  - Made the column `name` on table `stores` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "stores" ALTER COLUMN "name" SET NOT NULL;
