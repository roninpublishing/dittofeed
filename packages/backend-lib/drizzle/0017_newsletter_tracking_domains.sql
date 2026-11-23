CREATE TABLE "NewsletterTrackingDomain" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "newsletterId" uuid NOT NULL,
  "domain" text NOT NULL,
  "hostname" text NOT NULL,
  "isCurrent" boolean DEFAULT true NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "cloudflareStatus" text,
  "sslStatus" text,
  "customHostnameId" text,
  "dnsRecords" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "cnameVerified" boolean DEFAULT false NOT NULL,
  "lastCheckedAt" timestamp with time zone,
  "verifiedAt" timestamp with time zone,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "NewsletterTrackingDomain_hostname_unique" UNIQUE("hostname"),
  CONSTRAINT "NewsletterTrackingDomain_newsletterId_Newsletter_workspaceId_fk" FOREIGN KEY ("newsletterId") REFERENCES "public"."Newsletter"("workspaceId") ON DELETE cascade,
  CONSTRAINT "NewsletterTrackingDomain_status_check" CHECK ("status" in ('pending', 'active')),
  CONSTRAINT "NewsletterTrackingDomain_active_check" CHECK ("status" <> 'active' OR coalesce(("cnameVerified" AND "cloudflareStatus" = 'active' AND "sslStatus" = 'active' AND "verifiedAt" IS NOT NULL), false))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "NewsletterTrackingDomain_current_unique" ON "NewsletterTrackingDomain" USING btree ("newsletterId") WHERE "isCurrent";
--> statement-breakpoint
CREATE FUNCTION newsletter_tracking_immutable_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."newsletterId" IS DISTINCT FROM OLD."newsletterId" OR NEW."hostname" IS DISTINCT FROM OLD."hostname" OR NEW."domain" IS DISTINCT FROM OLD."domain" THEN
    RAISE EXCEPTION 'Tracking hostname ownership is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER newsletter_tracking_immutable_owner BEFORE UPDATE ON "NewsletterTrackingDomain" FOR EACH ROW EXECUTE FUNCTION newsletter_tracking_immutable_owner();
