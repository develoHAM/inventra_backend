-- Names only, no data moves: the company-profile table "users" becomes
-- "profiles", and what belongs to a profile or to the sign-in is named after
-- it. "accounts" (the sign-in) keeps its name. Every statement is a RENAME
-- (or an UPDATE of the permission codes), so every row, id and foreign key
-- stays exactly where it is.
--
-- Prisma can't tell a rename from "drop one, create another", so its own
-- version of this migration would drop these tables and lose every row.

-- 1. Tables -----------------------------------------------------------------

ALTER TABLE "users" RENAME TO "profiles";
ALTER TABLE "user_permissions" RENAME TO "profile_permissions";
ALTER TABLE "user_login_methods" RENAME TO "account_login_methods";

-- 2. The status enum (column defaults and the partial index's predicate
--    refer to the type itself, so they follow the new name) ----------------

ALTER TYPE "user_status" RENAME TO "profile_status";

-- 3. Columns that point at a profile: *_user_id → *_profile_id ---------------

ALTER TABLE "profile_permissions" RENAME COLUMN "user_id" TO "profile_id";
ALTER TABLE "membership_changes" RENAME COLUMN "user_id" TO "profile_id";
ALTER TABLE "membership_changes" RENAME COLUMN "changed_by_user_id" TO "changed_by_profile_id";
ALTER TABLE "notifications" RENAME COLUMN "recipient_user_id" TO "recipient_profile_id";
ALTER TABLE "companies" RENAME COLUMN "created_by_user_id" TO "created_by_profile_id";
ALTER TABLE "stores" RENAME COLUMN "deleted_by_user_id" TO "deleted_by_profile_id";
ALTER TABLE "company_stores" RENAME COLUMN "deleted_by_user_id" TO "deleted_by_profile_id";
ALTER TABLE "categories" RENAME COLUMN "deleted_by_user_id" TO "deleted_by_profile_id";
ALTER TABLE "brands" RENAME COLUMN "deleted_by_user_id" TO "deleted_by_profile_id";
ALTER TABLE "products" RENAME COLUMN "created_by_user_id" TO "created_by_profile_id";
ALTER TABLE "products" RENAME COLUMN "deleted_by_user_id" TO "deleted_by_profile_id";
ALTER TABLE "company_store_products" RENAME COLUMN "deleted_by_user_id" TO "deleted_by_profile_id";
ALTER TABLE "orders" RENAME COLUMN "created_by_user_id" TO "created_by_profile_id";
ALTER TABLE "orders" RENAME COLUMN "deleted_by_user_id" TO "deleted_by_profile_id";
ALTER TABLE "inventory_audits" RENAME COLUMN "created_by_user_id" TO "created_by_profile_id";
ALTER TABLE "inventory_audits" RENAME COLUMN "applied_by_user_id" TO "applied_by_profile_id";
ALTER TABLE "inventory_audits" RENAME COLUMN "deleted_by_user_id" TO "deleted_by_profile_id";
ALTER TABLE "inventory_transactions" RENAME COLUMN "created_by_user_id" TO "created_by_profile_id";
ALTER TABLE "purchase_reservations" RENAME COLUMN "created_by_user_id" TO "created_by_profile_id";

-- 4. Primary keys (renaming the constraint renames its index too) -----------

ALTER TABLE "profiles" RENAME CONSTRAINT "users_pkey" TO "profiles_pkey";
ALTER TABLE "profile_permissions" RENAME CONSTRAINT "user_permissions_pkey" TO "profile_permissions_pkey";
ALTER TABLE "account_login_methods" RENAME CONSTRAINT "user_login_methods_pkey" TO "account_login_methods_pkey";

-- 5. Foreign keys, to the names Prisma gives them (<table>_<column>_fkey) ---

ALTER TABLE "profiles" RENAME CONSTRAINT "users_account_id_fkey" TO "profiles_account_id_fkey";
ALTER TABLE "profiles" RENAME CONSTRAINT "users_company_id_fkey" TO "profiles_company_id_fkey";
ALTER TABLE "profiles" RENAME CONSTRAINT "users_company_store_id_fkey" TO "profiles_company_store_id_fkey";
ALTER TABLE "profiles" RENAME CONSTRAINT "users_role_id_fkey" TO "profiles_role_id_fkey";
ALTER TABLE "account_login_methods" RENAME CONSTRAINT "user_login_methods_account_id_fkey" TO "account_login_methods_account_id_fkey";
ALTER TABLE "profile_permissions" RENAME CONSTRAINT "user_permissions_user_id_fkey" TO "profile_permissions_profile_id_fkey";
ALTER TABLE "profile_permissions" RENAME CONSTRAINT "user_permissions_permission_id_fkey" TO "profile_permissions_permission_id_fkey";
ALTER TABLE "membership_changes" RENAME CONSTRAINT "membership_changes_user_id_fkey" TO "membership_changes_profile_id_fkey";
ALTER TABLE "membership_changes" RENAME CONSTRAINT "membership_changes_changed_by_user_id_fkey" TO "membership_changes_changed_by_profile_id_fkey";
ALTER TABLE "notifications" RENAME CONSTRAINT "notifications_recipient_user_id_fkey" TO "notifications_recipient_profile_id_fkey";
ALTER TABLE "companies" RENAME CONSTRAINT "companies_created_by_user_id_fkey" TO "companies_created_by_profile_id_fkey";
ALTER TABLE "stores" RENAME CONSTRAINT "stores_deleted_by_user_id_fkey" TO "stores_deleted_by_profile_id_fkey";
ALTER TABLE "company_stores" RENAME CONSTRAINT "company_stores_deleted_by_user_id_fkey" TO "company_stores_deleted_by_profile_id_fkey";
ALTER TABLE "categories" RENAME CONSTRAINT "categories_deleted_by_user_id_fkey" TO "categories_deleted_by_profile_id_fkey";
ALTER TABLE "brands" RENAME CONSTRAINT "brands_deleted_by_user_id_fkey" TO "brands_deleted_by_profile_id_fkey";
ALTER TABLE "products" RENAME CONSTRAINT "products_created_by_user_id_fkey" TO "products_created_by_profile_id_fkey";
ALTER TABLE "products" RENAME CONSTRAINT "products_deleted_by_user_id_fkey" TO "products_deleted_by_profile_id_fkey";
ALTER TABLE "company_store_products" RENAME CONSTRAINT "company_store_products_deleted_by_user_id_fkey" TO "company_store_products_deleted_by_profile_id_fkey";
ALTER TABLE "orders" RENAME CONSTRAINT "orders_created_by_user_id_fkey" TO "orders_created_by_profile_id_fkey";
ALTER TABLE "orders" RENAME CONSTRAINT "orders_deleted_by_user_id_fkey" TO "orders_deleted_by_profile_id_fkey";
ALTER TABLE "inventory_audits" RENAME CONSTRAINT "inventory_audits_created_by_user_id_fkey" TO "inventory_audits_created_by_profile_id_fkey";
ALTER TABLE "inventory_audits" RENAME CONSTRAINT "inventory_audits_applied_by_user_id_fkey" TO "inventory_audits_applied_by_profile_id_fkey";
ALTER TABLE "inventory_audits" RENAME CONSTRAINT "inventory_audits_deleted_by_user_id_fkey" TO "inventory_audits_deleted_by_profile_id_fkey";
ALTER TABLE "inventory_transactions" RENAME CONSTRAINT "inventory_transactions_created_by_user_id_fkey" TO "inventory_transactions_created_by_profile_id_fkey";
ALTER TABLE "purchase_reservations" RENAME CONSTRAINT "purchase_reservations_created_by_user_id_fkey" TO "purchase_reservations_created_by_profile_id_fkey";

-- 6. Indexes, to the names schema.prisma maps ------------------------------

ALTER INDEX "UQ_users_account_company" RENAME TO "UQ_profiles_account_company";
ALTER INDEX "IDX_users_company" RENAME TO "IDX_profiles_company";
ALTER INDEX "IDX_membership_changes_user_created" RENAME TO "IDX_membership_changes_profile_created";

-- 7. Permission codes follow the resource: users.* → profiles.* --------------
-- The ids stay, so every role's baseline and personal GRANT/DENY still
-- points at the same permission.

UPDATE "permissions"
SET "code" = 'profiles.' || substring("code" FROM 7),
    "resource" = 'profiles',
    "name" = replace("name", 'users', 'profiles'),
    "updated_at" = CURRENT_TIMESTAMP
WHERE "code" LIKE 'users.%';
