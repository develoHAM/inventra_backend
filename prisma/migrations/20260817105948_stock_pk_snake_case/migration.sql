/*
  Warnings:

  - The primary key for the `company_store_product_stocks` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `companyStoreProductId` on the `company_store_product_stocks` table. All the data in the column will be lost.
  - Added the required column `company_store_product_id` to the `company_store_product_stocks` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "company_store_product_stocks" DROP CONSTRAINT "company_store_product_stocks_companyStoreProductId_fkey";

-- AlterTable
ALTER TABLE "company_store_product_stocks" DROP CONSTRAINT "company_store_product_stocks_pkey",
DROP COLUMN "companyStoreProductId",
ADD COLUMN     "company_store_product_id" INTEGER NOT NULL,
ADD CONSTRAINT "company_store_product_stocks_pkey" PRIMARY KEY ("company_store_product_id");

-- AddForeignKey
ALTER TABLE "company_store_product_stocks" ADD CONSTRAINT "company_store_product_stocks_company_store_product_id_fkey" FOREIGN KEY ("company_store_product_id") REFERENCES "company_store_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
