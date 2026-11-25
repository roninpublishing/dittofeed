-- Registry-only cutover. The migrator runs this file in one transaction; lock out
-- admission and configuration writes until ownership and budget backfills agree.
-- Existing migrations, NewsletterRoute history, credential ciphertext, connection
-- IDs, send payloads/states/timestamps and webhook receipts are never replaced.
LOCK TABLE "PublisherSendgridAccount", "SendingConnection", "SendingIp",
  "SendingPool", "SendingPoolIp", "SendingPoolBinding", "NewsletterRoute",
  "NewsletterSend", "SendingIpBudget" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
-- Refuse ambiguous legacy cross-tenant ownership rather than silently moving a
-- credential or historical delivery to a different publisher.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "SendingConnection" c JOIN "Newsletter" n ON n."workspaceId" = c."newsletterId"
    WHERE c."publisherId" <> n."publisherId"
  ) OR EXISTS (
    SELECT 1 FROM "SendingPoolBinding" b
    JOIN "SendingConnection" c ON c."id" = b."connectionId"
    JOIN "SendingPool" p ON p."id" = b."poolId" WHERE c."publisherId" <> p."publisherId"
  ) OR EXISTS (
    SELECT 1 FROM "SendingPoolIp" membership
    JOIN "SendingPool" p ON p."id" = membership."poolId"
    JOIN "SendingIp" ip ON ip."id" = membership."ipId" WHERE p."publisherId" <> ip."publisherId"
  ) OR EXISTS (
    SELECT 1 FROM "NewsletterRoute" r
    JOIN "Newsletter" n ON n."workspaceId" = r."newsletterId"
    JOIN "SendingConnection" c ON c."id" = r."connectionId"
    JOIN "SendingPool" p ON p."id" = r."poolId"
    WHERE n."publisherId" <> c."publisherId" OR c."publisherId" <> p."publisherId"
  ) OR EXISTS (
    SELECT 1 FROM "NewsletterSend" s
    JOIN "Newsletter" n ON n."workspaceId" = s."workspaceId"
    JOIN "SendingConnection" c ON c."id" = s."connectionId"
    JOIN "SendingPool" p ON p."id" = s."poolId"
    JOIN "SendingIp" ip ON ip."id" = s."ipId"
    WHERE s."publisherId" <> n."publisherId" OR s."publisherId" <> c."publisherId"
      OR s."publisherId" <> p."publisherId" OR s."publisherId" <> ip."publisherId"
  ) THEN
    RAISE EXCEPTION 'ESP cutover requires consistent legacy publisher ownership' USING ERRCODE = '23514';
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE "PublisherSendgridAccount" ADD COLUMN "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  ADD COLUMN "name" text,
  ADD COLUMN "provider" text DEFAULT 'SendGrid' NOT NULL,
  ADD COLUMN "revision" integer DEFAULT 1 NOT NULL,
  ADD COLUMN "createdAt" timestamptz DEFAULT now() NOT NULL;
ALTER TABLE "PublisherSendgridAccount" DROP CONSTRAINT "PublisherSendgridAccount_pkey";
ALTER TABLE "PublisherSendgridAccount" ADD PRIMARY KEY ("id");
ALTER TABLE "SendingConnection" ADD COLUMN "accountId" uuid;
ALTER TABLE "SendingConnection" ALTER COLUMN "newsletterId" DROP NOT NULL;
ALTER TABLE "SendingConnection" DROP CONSTRAINT "SendingConnection_newsletterId_unique";
ALTER TABLE "SendingConnection" DROP CONSTRAINT "SendingConnection_newsletterId_Newsletter_workspaceId_fk";
ALTER TABLE "SendingConnection" ADD CONSTRAINT "SendingConnection_newsletterId_Newsletter_workspaceId_fk"
  FOREIGN KEY ("newsletterId") REFERENCES "Newsletter"("workspaceId") ON DELETE SET NULL;
ALTER TABLE "SendingIp" ADD COLUMN "accountId" uuid, ADD COLUMN "canonicalIpId" uuid;
-- Ownership must be established by fresh account-scoped provider inspection,
-- never inferred from legacy registration or inherited by duplicated aliases.
ALTER TABLE "SendingIp" ADD COLUMN "providerVerifiedAt" timestamptz,
  ADD COLUMN "verifiedAccountRevision" integer;
ALTER TABLE "SendingIp" DROP CONSTRAINT "SendingIp_publisherId_address_unique";
ALTER TABLE "SendingPool" ADD COLUMN "accountId" uuid, ADD COLUMN "providerPoolName" text;
ALTER TABLE "SendingPool" DROP CONSTRAINT "SendingPool_publisherId_name_unique";
ALTER TABLE "NewsletterSend" ADD COLUMN "accountId" uuid,
  ADD COLUMN "accountRevision" integer, ADD COLUMN "selection" jsonb,
  ADD COLUMN "candidateIpIds" jsonb, ADD COLUMN "actualIp" text;
ALTER TABLE "NewsletterSend" ALTER COLUMN "ipId" DROP NOT NULL,
  ALTER COLUMN "poolId" DROP NOT NULL, ALTER COLUMN "routeVersion" DROP NOT NULL;
CREATE TABLE "NewsletterDefault" (
  "newsletterId" uuid PRIMARY KEY,
  "selection" jsonb,
  "updatedAt" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "NewsletterDefault_newsletterId_Newsletter_workspaceId_fk"
    FOREIGN KEY ("newsletterId") REFERENCES "Newsletter"("workspaceId") ON DELETE CASCADE
);
--> statement-breakpoint
-- A legacy publisher may have resources before its management key was registered.
-- Only publishers with infrastructure gain an account; newsletters alone do not.
INSERT INTO "PublisherSendgridAccount" ("publisherId", "name")
SELECT owners."publisherId", 'SendGrid'
FROM (
  SELECT "publisherId" FROM "SendingConnection"
  UNION SELECT "publisherId" FROM "SendingIp"
  UNION SELECT "publisherId" FROM "SendingPool"
) owners
WHERE NOT EXISTS (
  SELECT 1 FROM "PublisherSendgridAccount" a WHERE a."publisherId" = owners."publisherId"
);
-- Reuse the original account row for the first existing credential owner. Each
-- remaining connection becomes its own account, copying management configuration
-- without modifying its existing subuser, API key, signing keys or revision.
UPDATE "PublisherSendgridAccount" a
SET "id" = c."id", "name" = CASE WHEN c."username" = '' THEN 'SendGrid' ELSE c."username" END,
  "createdAt" = c."createdAt"
FROM (
  SELECT DISTINCT ON ("publisherId") "id", "publisherId", "username", "createdAt"
  FROM "SendingConnection" ORDER BY "publisherId", "createdAt", "id"
) c
WHERE a."publisherId" = c."publisherId";
UPDATE "PublisherSendgridAccount" SET "name" = 'SendGrid' WHERE "name" IS NULL;
CREATE TEMP TABLE esp_legacy_primary_account ON COMMIT DROP AS
SELECT "publisherId", "id" AS "accountId" FROM "PublisherSendgridAccount";
INSERT INTO "PublisherSendgridAccount" (
  "id", "publisherId", "name", "provider", "revision", "createdAt",
  "encryptedManagementKey", "region", "callbackBaseUrl", "allowProviderWrites",
  "allowIpReassignment", "allowRealSends", "allTrafficControlled", "updatedAt"
)
SELECT c."id", c."publisherId", CASE WHEN c."username" = '' THEN 'SendGrid' ELSE c."username" END,
  a."provider", a."revision", c."createdAt", a."encryptedManagementKey", a."region",
  a."callbackBaseUrl", a."allowProviderWrites", a."allowIpReassignment",
  a."allowRealSends", a."allTrafficControlled", a."updatedAt"
FROM "SendingConnection" c
JOIN esp_legacy_primary_account p ON p."publisherId" = c."publisherId"
JOIN "PublisherSendgridAccount" a ON a."id" = p."accountId"
WHERE c."id" <> p."accountId";
UPDATE "SendingConnection" SET "accountId" = "id";
-- A management-only registration gets a local parent-identity credential slot.
-- This does not create a provider subuser or fabricate a usable sending key.
INSERT INTO "SendingConnection" ("publisherId", "accountId", "username", "administrativeEmail")
SELECT a."publisherId", a."id", '', ''
FROM "PublisherSendgridAccount" a
WHERE NOT EXISTS (SELECT 1 FROM "SendingConnection" c WHERE c."accountId" = a."id");
--> statement-breakpoint
-- Split shared pools into account-local resources. Keep every original pool ID
-- for one owner and every original binding ID; aliases receive new local IDs.
CREATE TEMP TABLE esp_legacy_pool_map ON COMMIT DROP AS
WITH owners AS (
  SELECT b."poolId", c."accountId" FROM "SendingPoolBinding" b
    JOIN "SendingConnection" c ON c."id" = b."connectionId"
  UNION SELECT r."poolId", c."accountId" FROM "NewsletterRoute" r
    JOIN "SendingConnection" c ON c."id" = r."connectionId"
  UNION SELECT s."poolId", c."accountId" FROM "NewsletterSend" s
    JOIN "SendingConnection" c ON c."id" = s."connectionId"
  UNION SELECT pool."id", p."accountId" FROM "SendingPool" pool
    JOIN esp_legacy_primary_account p ON p."publisherId" = pool."publisherId"
    WHERE NOT EXISTS (SELECT 1 FROM "SendingPoolBinding" b WHERE b."poolId" = pool."id")
      AND NOT EXISTS (SELECT 1 FROM "NewsletterRoute" r WHERE r."poolId" = pool."id")
      AND NOT EXISTS (SELECT 1 FROM "NewsletterSend" s WHERE s."poolId" = pool."id")
), numbered AS (
  SELECT *, row_number() OVER (PARTITION BY "poolId" ORDER BY "accountId") AS ordinal FROM owners
)
SELECT n."poolId" AS "oldPoolId", n."accountId",
  CASE WHEN n.ordinal = 1 THEN n."poolId" ELSE gen_random_uuid() END AS "poolId",
  coalesce((
    SELECT b."providerPoolName" FROM "SendingPoolBinding" b
    JOIN "SendingConnection" c ON c."id" = b."connectionId"
    WHERE b."poolId" = n."poolId" AND c."accountId" = n."accountId"
  ), pool."name") AS "providerPoolName"
FROM numbered n JOIN "SendingPool" pool ON pool."id" = n."poolId";
INSERT INTO "SendingPool" (
  "id", "publisherId", "accountId", "name", "providerPoolName", "createdAt", "updatedAt"
)
SELECT m."poolId", p."publisherId", m."accountId", p."name", m."providerPoolName", p."createdAt", p."updatedAt"
FROM esp_legacy_pool_map m JOIN "SendingPool" p ON p."id" = m."oldPoolId"
WHERE m."poolId" <> m."oldPoolId";
UPDATE "SendingPool" p SET "accountId" = m."accountId", "providerPoolName" = m."providerPoolName"
FROM esp_legacy_pool_map m WHERE p."id" = m."oldPoolId" AND m."poolId" = m."oldPoolId";
--> statement-breakpoint
CREATE TEMP TABLE esp_legacy_ip_map ON COMMIT DROP AS
WITH owners AS (
  SELECT pi."ipId", m."accountId" FROM "SendingPoolIp" pi
    JOIN esp_legacy_pool_map m ON m."oldPoolId" = pi."poolId"
  UNION SELECT s."ipId", c."accountId" FROM "NewsletterSend" s
    JOIN "SendingConnection" c ON c."id" = s."connectionId"
  UNION SELECT ip."id", p."accountId" FROM "SendingIp" ip
    JOIN esp_legacy_primary_account p ON p."publisherId" = ip."publisherId"
    WHERE NOT EXISTS (SELECT 1 FROM "SendingPoolIp" pi WHERE pi."ipId" = ip."id")
      AND NOT EXISTS (SELECT 1 FROM "NewsletterSend" s WHERE s."ipId" = ip."id")
), numbered AS (
  SELECT *, row_number() OVER (PARTITION BY "ipId" ORDER BY "accountId") AS ordinal FROM owners
)
SELECT "ipId" AS "oldIpId", "accountId",
  CASE WHEN ordinal = 1 THEN "ipId" ELSE gen_random_uuid() END AS "ipId"
FROM numbered;
-- inet validates and canonicalizes IPv4/IPv6 spellings, including identical
-- addresses registered by different publishers. Roots retain an original ID.
CREATE FUNCTION esp_physical_ip_identity(address text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE
    WHEN family(address::inet) = 6 AND address::inet <<= '::ffff:0:0/96'::inet
      THEN host('0.0.0.0'::inet + (address::inet - '::ffff:0:0'::inet))
    ELSE host(address::inet)
  END
$$;
CREATE TEMP TABLE esp_legacy_physical_ip ON COMMIT DROP AS
SELECT "id" AS "oldIpId",
  first_value("id") OVER (PARTITION BY esp_physical_ip_identity("address") ORDER BY "id") AS "canonicalIpId"
FROM "SendingIp";
INSERT INTO "SendingIp" (
  "id", "publisherId", "accountId", "canonicalIpId", "address", "status",
  "hourlyLimit", "dailyLimit", "warmupStartedAt", "warmupSchedule", "createdAt", "updatedAt"
)
SELECT m."ipId", ip."publisherId", m."accountId", physical."canonicalIpId", ip."address", ip."status",
  ip."hourlyLimit", ip."dailyLimit", ip."warmupStartedAt", ip."warmupSchedule", ip."createdAt", ip."updatedAt"
FROM esp_legacy_ip_map m JOIN "SendingIp" ip ON ip."id" = m."oldIpId"
JOIN esp_legacy_physical_ip physical ON physical."oldIpId" = ip."id"
WHERE m."ipId" <> m."oldIpId";
UPDATE "SendingIp" ip SET "accountId" = m."accountId", "canonicalIpId" = physical."canonicalIpId"
FROM esp_legacy_ip_map m JOIN esp_legacy_physical_ip physical ON physical."oldIpId" = m."oldIpId"
WHERE ip."id" = m."oldIpId" AND m."ipId" = m."oldIpId";
CREATE TEMP TABLE esp_legacy_pool_membership ON COMMIT DROP AS
SELECT * FROM "SendingPoolIp";
DELETE FROM "SendingPoolIp";
INSERT INTO "SendingPoolIp" ("poolId", "ipId")
SELECT pool."poolId", ip."ipId"
FROM esp_legacy_pool_membership pi
JOIN esp_legacy_pool_map pool ON pool."oldPoolId" = pi."poolId"
JOIN esp_legacy_ip_map ip ON ip."oldIpId" = pi."ipId" AND ip."accountId" = pool."accountId";
UPDATE "SendingPoolBinding" b SET "poolId" = m."poolId"
FROM esp_legacy_pool_map m, "SendingConnection" c
WHERE b."connectionId" = c."id" AND m."oldPoolId" = b."poolId" AND m."accountId" = c."accountId";
--> statement-breakpoint
-- Preserve every historical IP/pool/route-version value on sends. The new
-- snapshot describes equivalent account-owned resources, not a provider action.
-- Legacy admission authorized only the original deterministic physical IP.
-- Never widen an already-reserved retry to today's pool members: a changed pool
-- must fail pinned verification rather than acquire unreserved sending candidates.
UPDATE "NewsletterSend" s SET "accountId" = c."accountId", "accountRevision" = a."revision",
  "selection" = jsonb_build_object('accountId', c."accountId", 'mode', 'pool', 'poolId', pool."poolId"),
  "candidateIpIds" = (
    SELECT jsonb_build_array(ip."ipId") FROM esp_legacy_ip_map ip
    WHERE ip."oldIpId" = s."ipId" AND ip."accountId" = c."accountId"
  )
FROM "SendingConnection" c
JOIN "PublisherSendgridAccount" a ON a."id" = c."accountId"
JOIN esp_legacy_pool_map pool ON pool."accountId" = c."accountId"
WHERE s."connectionId" = c."id" AND pool."oldPoolId" = s."poolId";
INSERT INTO "NewsletterDefault" ("newsletterId", "selection", "updatedAt")
SELECT r."newsletterId",
  jsonb_build_object('accountId', c."accountId", 'mode', 'pool', 'poolId', pool."poolId"), r."updatedAt"
FROM "NewsletterRoute" r JOIN "SendingConnection" c ON c."id" = r."connectionId"
JOIN esp_legacy_pool_map pool ON pool."oldPoolId" = r."poolId" AND pool."accountId" = c."accountId";
-- Move only alias counters, summing reservations without creating capacity.
-- Existing canonical counters remain and receive all alias reservations.
WITH moved AS (
  DELETE FROM "SendingIpBudget" b USING "SendingIp" ip
  WHERE b."ipId" = ip."id" AND ip."canonicalIpId" <> ip."id"
  RETURNING ip."canonicalIpId", b."windowStart", b."windowSeconds", b."reserved"
)
INSERT INTO "SendingIpBudget" ("ipId", "windowStart", "windowSeconds", "reserved")
SELECT "canonicalIpId", "windowStart", "windowSeconds", sum("reserved")::integer
FROM moved GROUP BY "canonicalIpId", "windowStart", "windowSeconds"
ON CONFLICT ("ipId", "windowStart", "windowSeconds")
DO UPDATE SET "reserved" = "SendingIpBudget"."reserved" + excluded."reserved";
--> statement-breakpoint
ALTER TABLE "PublisherSendgridAccount" ALTER COLUMN "name" SET NOT NULL;
ALTER TABLE "SendingConnection" ALTER COLUMN "accountId" SET NOT NULL;
ALTER TABLE "SendingConnection" ADD CONSTRAINT "SendingConnection_accountId_unique" UNIQUE ("accountId");
ALTER TABLE "SendingIp" ALTER COLUMN "accountId" SET NOT NULL, ALTER COLUMN "canonicalIpId" SET NOT NULL;
ALTER TABLE "SendingPool" ALTER COLUMN "accountId" SET NOT NULL, ALTER COLUMN "providerPoolName" SET NOT NULL;
ALTER TABLE "NewsletterSend" ALTER COLUMN "accountId" SET NOT NULL,
  ALTER COLUMN "accountRevision" SET NOT NULL, ALTER COLUMN "selection" SET NOT NULL,
  ALTER COLUMN "candidateIpIds" SET NOT NULL;
ALTER TABLE "SendingConnection" ADD CONSTRAINT "SendingConnection_accountId_PublisherSendgridAccount_id_fk"
  FOREIGN KEY ("accountId") REFERENCES "PublisherSendgridAccount"("id") ON DELETE RESTRICT;
ALTER TABLE "SendingIp" ADD CONSTRAINT "SendingIp_accountId_PublisherSendgridAccount_id_fk"
  FOREIGN KEY ("accountId") REFERENCES "PublisherSendgridAccount"("id") ON DELETE RESTRICT;
ALTER TABLE "SendingIp" ADD CONSTRAINT "SendingIp_canonicalIpId_SendingIp_id_fk"
  FOREIGN KEY ("canonicalIpId") REFERENCES "SendingIp"("id") ON DELETE RESTRICT;
ALTER TABLE "SendingPool" ADD CONSTRAINT "SendingPool_accountId_PublisherSendgridAccount_id_fk"
  FOREIGN KEY ("accountId") REFERENCES "PublisherSendgridAccount"("id") ON DELETE RESTRICT;
ALTER TABLE "NewsletterSend" ADD CONSTRAINT "NewsletterSend_accountId_PublisherSendgridAccount_id_fk"
  FOREIGN KEY ("accountId") REFERENCES "PublisherSendgridAccount"("id") ON DELETE RESTRICT;
ALTER TABLE "SendingIp" ADD CONSTRAINT "SendingIp_accountId_address_unique" UNIQUE ("accountId", "address");
ALTER TABLE "SendingPool" ADD CONSTRAINT "SendingPool_accountId_name_unique" UNIQUE ("accountId", "name");
CREATE INDEX "SendingIp_canonicalIpId_index" ON "SendingIp" ("canonicalIpId");
--> statement-breakpoint
-- Account IDs cannot borrow another publisher's credentials/resources. Existing
-- send ipId/poolId columns are historical attribution, not ownership selectors.
CREATE FUNCTION esp_account_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "PublisherSendgridAccount" a
    WHERE a."id" = NEW."accountId" AND a."publisherId" = NEW."publisherId"
  ) THEN
    RAISE EXCEPTION 'ESP resource account belongs to another publisher' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."accountId" IS DISTINCT FROM OLD."accountId"
    OR NEW."publisherId" IS DISTINCT FROM OLD."publisherId") THEN
    RAISE EXCEPTION 'ESP resource ownership is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER esp_connection_owner BEFORE INSERT OR UPDATE ON "SendingConnection"
  FOR EACH ROW EXECUTE FUNCTION esp_account_owner_guard();
CREATE TRIGGER esp_ip_owner BEFORE INSERT OR UPDATE ON "SendingIp"
  FOR EACH ROW EXECUTE FUNCTION esp_account_owner_guard();
CREATE TRIGGER esp_pool_owner BEFORE INSERT OR UPDATE ON "SendingPool"
  FOR EACH ROW EXECUTE FUNCTION esp_account_owner_guard();
CREATE TRIGGER esp_send_owner BEFORE INSERT OR UPDATE ON "NewsletterSend"
  FOR EACH ROW EXECUTE FUNCTION esp_account_owner_guard();
--> statement-breakpoint
-- Serialize registration by normalized physical address. Never trust a caller's
-- proposed canonical ID: otherwise a new account could multiply physical capacity.
CREATE FUNCTION esp_ip_canonical_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE physical_address text; root_id uuid;
BEGIN
  physical_address := esp_physical_ip_identity(NEW."address");
  IF TG_OP = 'UPDATE' THEN
    IF NEW."address" IS DISTINCT FROM OLD."address"
      OR NEW."canonicalIpId" IS DISTINCT FROM OLD."canonicalIpId" THEN
      RAISE EXCEPTION 'Physical IP identity is immutable' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM "SendingIp" root WHERE root."id" = OLD."canonicalIpId" FOR UPDATE;
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(physical_address, 0));
  SELECT ip."canonicalIpId" INTO root_id FROM "SendingIp" ip
    WHERE esp_physical_ip_identity(ip."address") = physical_address ORDER BY ip."id" LIMIT 1;
  IF root_id IS NOT NULL THEN
    PERFORM 1 FROM "SendingIp" root WHERE root."id" = root_id FOR UPDATE;
  END IF;
  NEW."canonicalIpId" := coalesce(root_id, NEW."id");
  RETURN NEW;
END;
$$;
CREATE TRIGGER esp_ip_canonical BEFORE INSERT OR UPDATE ON "SendingIp"
  FOR EACH ROW EXECUTE FUNCTION esp_ip_canonical_guard();
--> statement-breakpoint
CREATE FUNCTION esp_pool_member_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "SendingPool" p JOIN "SendingIp" ip ON ip."accountId" = p."accountId"
    WHERE p."id" = NEW."poolId" AND ip."id" = NEW."ipId"
  ) THEN
    RAISE EXCEPTION 'Pool member belongs to another ESP account' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER esp_pool_member BEFORE INSERT OR UPDATE ON "SendingPoolIp"
  FOR EACH ROW EXECUTE FUNCTION esp_pool_member_guard();
CREATE FUNCTION esp_pool_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "SendingPool" p JOIN "SendingConnection" c ON c."accountId" = p."accountId"
    WHERE p."id" = NEW."poolId" AND c."id" = NEW."connectionId"
      AND p."providerPoolName" = NEW."providerPoolName"
  ) THEN
    RAISE EXCEPTION 'Pool binding does not match its ESP account and provider identity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER esp_pool_binding BEFORE INSERT OR UPDATE ON "SendingPoolBinding"
  FOR EACH ROW EXECUTE FUNCTION esp_pool_binding_guard();
--> statement-breakpoint
CREATE FUNCTION esp_budget_canonical_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "SendingIp" ip WHERE ip."id" = NEW."ipId" AND ip."canonicalIpId" = ip."id"
  ) THEN
    RAISE EXCEPTION 'IP budgets must use the canonical physical identity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER esp_budget_canonical BEFORE INSERT OR UPDATE ON "SendingIpBudget"
  FOR EACH ROW EXECUTE FUNCTION esp_budget_canonical_guard();
--> statement-breakpoint
CREATE FUNCTION esp_send_selection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."accountId" IS DISTINCT FROM OLD."accountId"
      OR NEW."accountRevision" IS DISTINCT FROM OLD."accountRevision"
      OR NEW."connectionId" IS DISTINCT FROM OLD."connectionId"
      OR NEW."connectionRevision" IS DISTINCT FROM OLD."connectionRevision"
      OR NEW."selection" IS DISTINCT FROM OLD."selection"
      OR NEW."candidateIpIds" IS DISTINCT FROM OLD."candidateIpIds"
      OR NEW."ipId" IS DISTINCT FROM OLD."ipId"
      OR NEW."poolId" IS DISTINCT FROM OLD."poolId" THEN
      RAISE EXCEPTION 'Confirmed ESP attempt selection is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "SendingConnection" c
    WHERE c."id" = NEW."connectionId" AND c."accountId" = NEW."accountId"
  ) OR NEW."selection"->>'accountId' IS DISTINCT FROM NEW."accountId"::text
    OR coalesce(NEW."selection"->>'mode', '') NOT IN ('automatic', 'pool', 'ip')
    OR jsonb_typeof(NEW."candidateIpIds") IS DISTINCT FROM 'array'
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(NEW."candidateIpIds") candidate
      WHERE NOT EXISTS (
        SELECT 1 FROM "SendingIp" ip WHERE ip."id"::text = candidate.value AND ip."accountId" = NEW."accountId"
      )
    ) THEN
    RAISE EXCEPTION 'Attempt selection crosses ESP account ownership' USING ERRCODE = '23514';
  END IF;
  IF (NEW."selection"->>'mode' = 'pool' AND NOT EXISTS (
    SELECT 1 FROM "SendingPool" p
    WHERE p."id"::text = NEW."selection"->>'poolId' AND p."accountId" = NEW."accountId"
  )) OR (NEW."selection"->>'mode' = 'ip' AND NOT EXISTS (
    SELECT 1 FROM "SendingIp" ip
    WHERE ip."id"::text = NEW."selection"->>'ipId' AND ip."accountId" = NEW."accountId"
  )) THEN
    RAISE EXCEPTION 'Selected resource belongs to another ESP account' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER esp_send_selection BEFORE INSERT OR UPDATE ON "NewsletterSend"
  FOR EACH ROW EXECUTE FUNCTION esp_send_selection_guard();
--> statement-breakpoint
CREATE FUNCTION esp_account_publisher_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."publisherId" IS DISTINCT FROM OLD."publisherId" THEN
    RAISE EXCEPTION 'ESP account publisher is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER esp_account_publisher BEFORE UPDATE ON "PublisherSendgridAccount"
  FOR EACH ROW EXECUTE FUNCTION esp_account_publisher_guard();