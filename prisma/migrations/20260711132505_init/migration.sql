-- CreateEnum
CREATE TYPE "transaction_source_type" AS ENUM ('ORDER', 'AUDIT', 'RESERVATION');

-- CreateEnum
CREATE TYPE "inventory_transaction_type" AS ENUM ('INITIAL_STOCK', 'RESTOCK', 'TRANSFER_IN', 'TRANSFER_OUT', 'ADJUSTMENT', 'SALE', 'RETURN', 'DAMAGED_DISPOSAL', 'DAMAGED_RETURN', 'SAMPLE_ALLOCATION', 'SAMPLE_TRANSFER_IN', 'SAMPLE_TRANSFER_OUT', 'SAMPLE_RETURN', 'SAMPLE_DISPOSAL');

-- CreateEnum
CREATE TYPE "reservation_status" AS ENUM ('PENDING', 'RESERVED', 'FULFILLED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "permission_effect" AS ENUM ('GRANT', 'DENY');

-- CreateTable
CREATE TABLE "stores" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(255),
    "store_address" VARCHAR(255),
    "store_phone" VARCHAR(20),
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "companies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(100) NOT NULL,
    "tax_id" VARCHAR(20),
    "head_office_address" VARCHAR(255),
    "description" TEXT,
    "head_office_phone" VARCHAR(20),
    "head_office_email" VARCHAR(255),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_stores" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "manager_user_id" UUID,
    "name" VARCHAR(255),
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_stores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_audits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_store_id" UUID NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "file_url" VARCHAR(2048),
    "audited_date" TIMESTAMPTZ(6) NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_audits_pkey" PRIMARY KEY ("id","company_store_id")
);

-- CreateTable
CREATE TABLE "inventory_audit_items" (
    "inventory_audit_id" UUID NOT NULL,
    "company_store_id" UUID NOT NULL,
    "company_store_product_id" INTEGER NOT NULL,
    "product_quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_audit_items_pkey" PRIMARY KEY ("inventory_audit_id","company_store_id","company_store_product_id")
);

-- CreateTable
CREATE TABLE "inventory_transactions" (
    "id" SERIAL NOT NULL,
    "company_store_product_id" INTEGER NOT NULL,
    "transaction_type" "inventory_transaction_type" NOT NULL,
    "quantity" INTEGER,
    "quantity_before" INTEGER,
    "quantity_after" INTEGER,
    "remarks" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_type" "transaction_source_type",
    "source_id" UUID,

    CONSTRAINT "inventory_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_store_id" UUID NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "file_url" VARCHAR(2048),
    "order_date" TIMESTAMPTZ(6) NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id","company_store_id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "order_id" UUID NOT NULL,
    "company_store_id" UUID NOT NULL,
    "company_store_product_id" INTEGER NOT NULL,
    "product_order_quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("order_id","company_store_id","company_store_product_id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "description" TEXT,
    "parent_category_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brands" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "name_kr" VARCHAR(100),
    "description" TEXT,
    "logo_url" VARCHAR(2048),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_company_id" UUID NOT NULL,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(255) NOT NULL,
    "barcode" VARCHAR(100) NOT NULL,
    "company_id" UUID NOT NULL,
    "category_id" INTEGER NOT NULL,
    "brand_id" INTEGER NOT NULL,
    "price_krw" INTEGER NOT NULL,
    "color" VARCHAR(255),
    "image_url" VARCHAR(2048),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_store_products" (
    "id" SERIAL NOT NULL,
    "company_store_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "target_stock_quantity" INTEGER NOT NULL DEFAULT 0,
    "sample_quantity" INTEGER NOT NULL DEFAULT 0,
    "reserved_quantity" INTEGER NOT NULL DEFAULT 0,
    "current_quantity" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_store_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_reservations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_store_product_id" INTEGER NOT NULL,
    "company_store_id" UUID NOT NULL,
    "reserved_by_name" VARCHAR(100) NOT NULL,
    "reserved_by_phone" VARCHAR(20),
    "reserved_quantity" INTEGER NOT NULL,
    "status" "reservation_status" NOT NULL DEFAULT 'PENDING',
    "remark" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "fulfilled_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "cancel_reason" TEXT,
    "reserved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "role_id" INTEGER NOT NULL,
    "company_store_id" UUID,
    "phone" VARCHAR(20),
    "profile_image_url" VARCHAR(2048),
    "biography" TEXT,
    "status" "user_status" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_login_methods" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "method" VARCHAR(20) NOT NULL,
    "password_hash" TEXT,
    "provider" VARCHAR(30),
    "provider_user_id" VARCHAR(255),
    "email" VARCHAR(255),
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "token_expires_at" TIMESTAMPTZ(6),
    "provider_metadata" JSONB,
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_login_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "description" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "code" VARCHAR(100) NOT NULL,
    "description" VARCHAR(255),
    "resource" VARCHAR(50) NOT NULL,
    "action" VARCHAR(50) NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "permission_id" INTEGER NOT NULL,
    "role_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("permission_id","role_id")
);

-- CreateTable
CREATE TABLE "user_permissions" (
    "user_id" UUID NOT NULL,
    "permission_id" INTEGER NOT NULL,
    "effect" "permission_effect" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_permissions_pkey" PRIMARY KEY ("user_id","permission_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UQ_companies_tax_id" ON "companies"("tax_id");

-- CreateIndex
CREATE INDEX "IDX_inventory_audits_company_store" ON "inventory_audits"("company_store_id");

-- CreateIndex
CREATE INDEX "IDX_inventory_transactions_source" ON "inventory_transactions"("source_type", "source_id");

-- CreateIndex
CREATE INDEX "IDX_orders_company_store" ON "orders"("company_store_id");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_products_barcode" ON "products"("barcode");

-- CreateIndex
CREATE INDEX "IDX_products_company" ON "products"("company_id");

-- CreateIndex
CREATE INDEX "IDX_company_store_products_company_store" ON "company_store_products"("company_store_id");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_csp_id_company_store" ON "company_store_products"("id", "company_store_id");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_csp_product_company_store" ON "company_store_products"("product_id", "company_store_id");

-- CreateIndex
CREATE INDEX "IDX_users_company" ON "users"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_roles_code" ON "roles"("code");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_permissions_code" ON "permissions"("code");

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_stores" ADD CONSTRAINT "company_stores_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_stores" ADD CONSTRAINT "company_stores_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_stores" ADD CONSTRAINT "company_stores_manager_user_id_fkey" FOREIGN KEY ("manager_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_audits" ADD CONSTRAINT "inventory_audits_company_store_id_fkey" FOREIGN KEY ("company_store_id") REFERENCES "company_stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_audits" ADD CONSTRAINT "inventory_audits_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_audit_items" ADD CONSTRAINT "inventory_audit_items_inventory_audit_id_company_store_id_fkey" FOREIGN KEY ("inventory_audit_id", "company_store_id") REFERENCES "inventory_audits"("id", "company_store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_audit_items" ADD CONSTRAINT "inventory_audit_items_company_store_product_id_company_sto_fkey" FOREIGN KEY ("company_store_product_id", "company_store_id") REFERENCES "company_store_products"("id", "company_store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_company_store_product_id_fkey" FOREIGN KEY ("company_store_product_id") REFERENCES "company_store_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_company_store_id_fkey" FOREIGN KEY ("company_store_id") REFERENCES "company_stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_company_store_id_fkey" FOREIGN KEY ("order_id", "company_store_id") REFERENCES "orders"("id", "company_store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_company_store_product_id_company_store_id_fkey" FOREIGN KEY ("company_store_product_id", "company_store_id") REFERENCES "company_store_products"("id", "company_store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_category_id_fkey" FOREIGN KEY ("parent_category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brands" ADD CONSTRAINT "brands_created_by_company_id_fkey" FOREIGN KEY ("created_by_company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_store_products" ADD CONSTRAINT "company_store_products_company_store_id_fkey" FOREIGN KEY ("company_store_id") REFERENCES "company_stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_store_products" ADD CONSTRAINT "company_store_products_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_reservations" ADD CONSTRAINT "purchase_reservations_company_store_product_id_company_sto_fkey" FOREIGN KEY ("company_store_product_id", "company_store_id") REFERENCES "company_store_products"("id", "company_store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_company_store_id_fkey" FOREIGN KEY ("company_store_id") REFERENCES "company_stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_login_methods" ADD CONSTRAINT "user_login_methods_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Enforce that source_type and source_id are both set or both null
ALTER TABLE "inventory_transactions"
ADD CONSTRAINT "CHK_source_pair_consistency"
CHECK (("source_type" IS NULL) = ("source_id" IS NULL));