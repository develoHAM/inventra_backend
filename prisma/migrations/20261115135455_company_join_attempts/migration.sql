-- CreateTable
CREATE TABLE "company_join_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_join_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IDX_company_join_attempts_account_created" ON "company_join_attempts"("account_id", "created_at");

-- AddForeignKey
ALTER TABLE "company_join_attempts" ADD CONSTRAINT "company_join_attempts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
