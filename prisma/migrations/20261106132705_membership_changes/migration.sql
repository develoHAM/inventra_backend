-- CreateEnum
CREATE TYPE "membership_change_reason" AS ENUM ('APPROVED', 'MOVED', 'ROLE_CHANGED', 'BRANCH_DELETED');

-- CreateTable
CREATE TABLE "membership_changes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "reason" "membership_change_reason" NOT NULL,
    "from_role_id" INTEGER,
    "to_role_id" INTEGER,
    "from_company_store_id" UUID,
    "to_company_store_id" UUID,
    "changed_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IDX_membership_changes_user_created" ON "membership_changes"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "IDX_membership_changes_company_created" ON "membership_changes"("company_id", "created_at");

-- CreateIndex
CREATE INDEX "IDX_membership_changes_from_branch" ON "membership_changes"("from_company_store_id");

-- CreateIndex
CREATE INDEX "IDX_membership_changes_to_branch" ON "membership_changes"("to_company_store_id");

-- AddForeignKey
ALTER TABLE "membership_changes" ADD CONSTRAINT "membership_changes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_changes" ADD CONSTRAINT "membership_changes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_changes" ADD CONSTRAINT "membership_changes_changed_by_user_id_fkey" FOREIGN KEY ("changed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_changes" ADD CONSTRAINT "membership_changes_from_role_id_fkey" FOREIGN KEY ("from_role_id") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_changes" ADD CONSTRAINT "membership_changes_to_role_id_fkey" FOREIGN KEY ("to_role_id") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_changes" ADD CONSTRAINT "membership_changes_from_company_store_id_fkey" FOREIGN KEY ("from_company_store_id") REFERENCES "company_stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_changes" ADD CONSTRAINT "membership_changes_to_company_store_id_fkey" FOREIGN KEY ("to_company_store_id") REFERENCES "company_stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;
