-- DropForeignKey
ALTER TABLE "categories" DROP CONSTRAINT "categories_deleted_by_user_id_fkey";

-- AlterTable
ALTER TABLE "brands" ADD COLUMN     "deleted_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "categories" ALTER COLUMN "deleted_by_user_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_deleted_by_user_id_fkey" FOREIGN KEY ("deleted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
