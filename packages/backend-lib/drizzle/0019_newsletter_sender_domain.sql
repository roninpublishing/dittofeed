-- Historical sender domains are unknown: never decrypt payloads or infer inventory.
ALTER TABLE "NewsletterSend" ADD COLUMN "senderDomain" text;
--> statement-breakpoint
CREATE INDEX "NewsletterSend_publisher_period_sender_idx"
  ON "NewsletterSend" ("publisherId", "createdAt", "accountId", "senderDomain");
--> statement-breakpoint
CREATE FUNCTION newsletter_send_immutable_sender_domain() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."senderDomain" IS DISTINCT FROM OLD."senderDomain" THEN
    RAISE EXCEPTION 'Send sender domain is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER newsletter_send_immutable_sender_domain BEFORE UPDATE ON "NewsletterSend"
  FOR EACH ROW EXECUTE FUNCTION newsletter_send_immutable_sender_domain();
