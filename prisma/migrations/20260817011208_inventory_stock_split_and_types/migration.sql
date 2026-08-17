/*
  Warnings:

  - You are about to drop the column `current_quantity` on the `company_store_products` table. All the data in the column will be lost.
  - You are about to drop the column `reserved_quantity` on the `company_store_products` table. All the data in the column will be lost.
  - You are about to drop the column `sample_quantity` on the `company_store_products` table. All the data in the column will be lost.
  - You are about to drop the column `target_stock_quantity` on the `company_store_products` table. All the data in the column will be lost.

*/
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "inventory_transaction_type" ADD VALUE 'CUSTOMER_RETURN';
ALTER TYPE "inventory_transaction_type" ADD VALUE 'CUSTOMER_DAMAGED_RETURN';
ALTER TYPE "inventory_transaction_type" ADD VALUE 'BREAKAGE';

-- AlterTable
ALTER TABLE "company_store_products" DROP COLUMN "current_quantity",
DROP COLUMN "reserved_quantity",
DROP COLUMN "sample_quantity",
DROP COLUMN "target_stock_quantity";

-- CreateTable
CREATE TABLE "company_store_product_stocks" (
    "companyStoreProductId" INTEGER NOT NULL,
    "target_stock_quantity" INTEGER NOT NULL DEFAULT 0,
    "available_quantity" INTEGER NOT NULL DEFAULT 0,
    "reserved_quantity" INTEGER NOT NULL DEFAULT 0,
    "sample_quantity" INTEGER NOT NULL DEFAULT 0,
    "damaged_quantity" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_store_product_stocks_pkey" PRIMARY KEY ("companyStoreProductId")
);

-- AddForeignKey
ALTER TABLE "company_store_product_stocks" ADD CONSTRAINT "company_store_product_stocks_companyStoreProductId_fkey" FOREIGN KEY ("companyStoreProductId") REFERENCES "company_store_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
