-- AlterTable
ALTER TABLE "brands" ADD COLUMN     "deleted_at" TIMESTAMPTZ(6),
ADD COLUMN     "deleted_by_user_id" UUID;

-- AlterTable
ALTER TABLE "categories" ADD COLUMN     "deleted_by_user_id" UUID;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "deleted_by_user_id" UUID;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_deleted_by_user_id_fkey" FOREIGN KEY ("deleted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brands" ADD CONSTRAINT "brands_deleted_by_user_id_fkey" FOREIGN KEY ("deleted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_deleted_by_user_id_fkey" FOREIGN KEY ("deleted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
