-- Follow-up to 20261107182006_branch_managers (applied as generated, before
-- its data step was added). Data only: no schema change.
-- The manager → branch copy is not needed: no database had corners with a
-- manager when manager_user_id was dropped.

-- Members pointing at a deleted corner have no branch.
UPDATE "users" SET "company_store_id" = NULL
WHERE "company_store_id" IN (SELECT "id" FROM "company_stores" WHERE "deleted_at" IS NOT NULL);

-- Owners and the admin have no branch.
UPDATE "users" u SET "company_store_id" = NULL
FROM "roles" r
WHERE u."role_id" = r."id" AND r."code" IN ('OWNER', 'ADMIN') AND u."company_store_id" IS NOT NULL;

-- corners.assign is replaced by users.move. Children first (they reference it).
DELETE FROM "role_permissions" WHERE "permission_id" IN (SELECT "id" FROM "permissions" WHERE "code" = 'corners.assign');
DELETE FROM "user_permissions" WHERE "permission_id" IN (SELECT "id" FROM "permissions" WHERE "code" = 'corners.assign');
DELETE FROM "permissions" WHERE "code" = 'corners.assign';
