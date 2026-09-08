/*
  Warnings:

  - Added the required column `created_by_user_id` to the `purchase_reservations` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "inventory_transaction_type" ADD VALUE 'RESERVATION_HOLD';
ALTER TYPE "inventory_transaction_type" ADD VALUE 'RESERVATION_RELEASE';

-- AlterTable
ALTER TABLE "purchase_reservations" ADD COLUMN     "created_by_user_id" UUID NOT NULL;

-- AddForeignKey
ALTER TABLE "purchase_reservations" ADD CONSTRAINT "purchase_reservations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
