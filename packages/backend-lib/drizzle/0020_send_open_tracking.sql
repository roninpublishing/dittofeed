ALTER TABLE "NewsletterSend" ADD COLUMN "openTrackingTokenHash" text;
--> statement-breakpoint
ALTER TABLE "NewsletterSend" ADD COLUMN "encryptedOpenTrackingToken" jsonb;
--> statement-breakpoint
ALTER TABLE "NewsletterSend" ADD COLUMN "openTrackingOrigin" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "NewsletterSend_openTrackingTokenHash_unique" ON "NewsletterSend" ("openTrackingTokenHash") WHERE "openTrackingTokenHash" IS NOT NULL;
--> statement-breakpoint
-- Development-only removal: historical tracking data must never be discarded.
DO $$
BEGIN
  LOCK TABLE "EmailOpenTrackingReceipt", "EmailOpenTrackingSend", "EmailOpenTrackingTombstone" IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM "EmailOpenTrackingReceipt")
    OR EXISTS (SELECT 1 FROM "EmailOpenTrackingSend")
    OR EXISTS (SELECT 1 FROM "EmailOpenTrackingTombstone") THEN
    RAISE EXCEPTION 'Open tracking cutover requires empty legacy tracking tables; preserve and migrate existing data before retrying';
  END IF;
  DROP TABLE "EmailOpenTrackingReceipt";
  DROP TABLE "EmailOpenTrackingSend";
  DROP TABLE "EmailOpenTrackingTombstone";
END $$;
