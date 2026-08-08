-- AlterTable
ALTER TABLE "company_stores" ADD COLUMN     "deleted_at" TIMESTAMPTZ(6),
ADD COLUMN     "deleted_by_user_id" UUID;

-- AlterTable
ALTER TABLE "stores" ADD COLUMN     "deleted_at" TIMESTAMPTZ(6),
ADD COLUMN     "deleted_by_user_id" UUID;

-- AddForeignKey
ALTER TABLE "stores" ADD CONSTRAINT "stores_deleted_by_user_id_fkey" FOREIGN KEY ("deleted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_stores" ADD CONSTRAINT "company_stores_deleted_by_user_id_fkey" FOREIGN KEY ("deleted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
