-- Emails are case-insensitive: every email is stored trimmed and lowercase.
-- Data only; the schema does not change.

-- Change nothing if two password logins would end up with the same email:
-- that has to be resolved by hand first (login could not tell them apart).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "user_login_methods"
    WHERE "method" = 'local' AND "email" IS NOT NULL
    GROUP BY lower(btrim("email"))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Two password logins share an email once lowercased; fix them before this migration';
  END IF;
END $$;

UPDATE "user_login_methods"
SET "email" = lower(btrim("email"))
WHERE "email" IS NOT NULL AND "email" <> lower(btrim("email"));

UPDATE "users"
SET "contact_email" = lower(btrim("contact_email"))
WHERE "contact_email" IS NOT NULL AND "contact_email" <> lower(btrim("contact_email"));

UPDATE "social_signup_tickets"
SET "email" = lower(btrim("email"))
WHERE "email" IS NOT NULL AND "email" <> lower(btrim("email"));
