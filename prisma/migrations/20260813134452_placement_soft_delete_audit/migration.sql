-- AlterTable
ALTER TABLE "company_store_products" ADD COLUMN     "deleted_at" TIMESTAMPTZ(6),
ADD COLUMN     "deleted_by_user_id" UUID;

-- AddForeignKey
ALTER TABLE "company_store_products" ADD CONSTRAINT "company_store_products_deleted_by_user_id_fkey" FOREIGN KEY ("deleted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
