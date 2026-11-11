-- DropForeignKey
ALTER TABLE "membership_changes" DROP CONSTRAINT "membership_changes_changed_by_user_id_fkey";

-- DropForeignKey
ALTER TABLE "membership_changes" DROP CONSTRAINT "membership_changes_from_company_store_id_fkey";

-- DropForeignKey
ALTER TABLE "membership_changes" DROP CONSTRAINT "membership_changes_from_role_id_fkey";

-- DropForeignKey
ALTER TABLE "membership_changes" DROP CONSTRAINT "membership_changes_to_company_store_id_fkey";

-- DropForeignKey
ALTER TABLE "membership_changes" DROP CONSTRAINT "membership_changes_to_role_id_fkey";

-- AddForeignKey
ALTER TABLE "membership_changes" ADD CONSTRAINT "membership_changes_changed_by_user_id_fkey" FOREIGN KEY ("changed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_changes" ADD CONSTRAINT "membership_changes_from_role_id_fkey" FOREIGN KEY ("from_role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_changes" ADD CONSTRAINT "membership_changes_to_role_id_fkey" FOREIGN KEY ("to_role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_changes" ADD CONSTRAINT "membership_changes_from_company_store_id_fkey" FOREIGN KEY ("from_company_store_id") REFERENCES "company_stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_changes" ADD CONSTRAINT "membership_changes_to_company_store_id_fkey" FOREIGN KEY ("to_company_store_id") REFERENCES "company_stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
