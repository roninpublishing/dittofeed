# Deliverability: IP and domain health plan

Status: **planned, not implemented.** This records the approved direction for a
modular deliverability section. Operational procedures (warm-up execution,
delisting, incident response) come later. Nothing here authorizes provider
writes, IP purchases or reassignment, DNS changes, or email sends.

## Goal

One place to see every sending IP and domain across all providers, whether each
IP is dedicated or shared, and its health:

- **Publisher level** (above newsletters): everything the publisher owns or uses.
- **Newsletter level**: only the IPs and domains that newsletter actually sends
  through, plus its own delivery rates.

The section is a self-contained module with pluggable signal sources. Each
source can be enabled, configured and removed independently.

## What the research found (November 2026)

| Source | Covers | What it gives | Limits |
|---|---|---|---|
| Google Postmaster Tools API v2 | Domains | Spam rate, feedback-loop spam rates, SPF/DKIM/DMARC success, TLS rates, delivery errors, and `getComplianceStatus` (SPF, DKIM, DMARC alignment, one-click unsubscribe, plus a deliverability verdict since June 2026) | **No domain or IP reputation scores**: Google retired them and v2 does not carry them. Domain-level only, no per-IP data. Data only for domains sending to 50+ Gmail users a day. OAuth scopes `postmaster` or `postmaster.traffic.readonly`, with DNS-verified domains. v1 (`trafficStats`) is being retired, so build on v2 only. |
| Microsoft SNDS | IPs | Per-IP filter status (green/yellow/red), complaint rate, message volume at Outlook.com/Hotmail/Live | **Dedicated IPs only**: shared-pool IPs can't be registered. Needs 100+ messages a day per IP to show data. New portal since June 2026; automated-access CSV links had to be regenerated. Spam-trap counts removed July 2026. Doesn't cover Microsoft 365 tenants. |
| Yahoo Sender Hub | Domains | Complaint Feedback Loop (CFL): ARF reports by email, DKIM-domain based | No public reporting API. CFL arrives as email, so ingest it from an inbound mailbox. Insights is UI-only. |
| Blocklists (DNSBL) | IPs and domains | Listing status | Spamhaus requires a **paid subscription for commercial use** (DQS key, ZEN for IPs, DBL for domains, 30-day free trial). Alternative: HetrixTools API (about $10–40/month, includes API access), or MXToolbox (higher cost). |
| DNS posture (our own checks) | IPs and domains | SPF, DKIM selectors, DMARC policy, MTA-STS, TLS-RPT, BIMI, IP PTR/forward-confirmed rDNS, tracking CNAME | Free. Built in-house. |
| DMARC aggregate reports (`rua`) | Domains, plus every IP sending as them | Who sends as your domain, pass/fail by source IP | Self-host parsing (parsedmarc-style) or use a vendor (dmarcian, EasyDMARC, Valimail). Self-hosting fits our stack. |
| SendGrid API | IPs and domains | IP inventory, pools, subusers, warm-up status, rDNS, domain authentication | **No reputation data**: SendGrid leaves IP reputation monitoring to the customer. The existing client already reads `/ips`, `/ips/pools` and `/whitelabel/domains`. |
| Amazon SES | IPs and domains | Managed dedicated IPs: per-ISP reputation and SNDS metrics as CloudWatch metrics. VDM: per-provider delivery, bounce and complaint rates. | VDM Global deliverability (blocklists plus wider coverage) costs about $1,250/month per region. Only relevant if SES is used. |
| First-party (already built) | IPs, newsletters | Per-IP and per-newsletter sent, delivered, bounced, dropped, spam-report, open and click counts from signed webhooks (`getPublisherDeliveryHealth`) | Our own observations. Strongest signal for shared IPs. |

Conclusions:
1. No single tool gives "IP reputation". Health is a composite of first-party
   bounce and complaint rates, SNDS (dedicated IPs), blocklists, PTR and auth
   posture, and Postmaster domain data.
2. Shared IPs can only be judged by first-party rates, blocklists and the
   provider's status. Show them as shared, with fewer signals, not as "healthy".
3. Gmail health is **domain-based** now (spam rate plus compliance), so domain
   health matters as much as IP health.

## Buy the signals, build only the view

Several vendors already collect these signals. Don't rebuild Postmaster, SNDS,
blocklist and seed-test collection ourselves. Buy one monitoring backend, keep
first-party data we already have, and build only the registry, the adapter and
the UI.

| Vendor | What it already does | API | Price (Nov 2026) | Fit |
|---|---|---|---|---|
| **Mailgun Optimize** | IP and domain blocklist monitoring (Spamhaus, CBL, SpamCop, DBL, URIBL, SURBL; content/HBL added Oct 2026), spam-trap monitoring, Google Postmaster integration, SNDS integration (Starter and up), inbox placement seed tests, bounce classification. Works with any ESP, not only Mailgun. | **Documented**: register, list, update and remove monitored IPs and domains; blocklist events; alert webhooks. | Pilot $49/mo, Starter $99/mo (blocklists, spam traps, Postmaster, SNDS), Contract custom | **Recommended primary.** Broadest documented API at low cost, and ESP-neutral. |
| **GlockApps** | Seed tests across 30+ providers, Google Postmaster v2 data and alerts, blocklist and IP reputation monitors, DMARC analytics, DNS checks. Hosted MCP server. | Claimed on every plan, including free (`x-api-key`). Endpoint reference didn't render, so it's **unverified**. | Free; $59, $99, $129/mo (Agencies tier) | Strong second choice or add-on for seed testing. Verify endpoints with a trial key first. |
| **Inbox Monster** | Pulls Google Postmaster v2, Microsoft SNDS and the Spamhaus domain reputation feed into one dashboard, plus blocklists and seed tests. ESP-neutral. | No public API documentation found. | Quote only | Good dashboard, weak for integration. |
| **Validity Everest** | Most complete: Sender Score, domain and IP reputation trends, 200+ blocklists, Postmaster and SNDS, Universal Feedback Loop, seed tests. | Enterprise tier only. | Roughly $20k–100k+/yr (third-party estimates) | Overkill now. Revisit at large scale. |
| **Suped** | DMARC `rua` processing, hosted SPF/DKIM/DMARC/MTA-STS/BIMI, blocklists, Postmaster (not for MSP orgs), webhook alerts, MCP. | Narrow: one read-only REST endpoint (DMARC records). MCP adds domains and issues. API on Enterprise/MSP only. | Free; Business about $19–24/mo; Enterprise/MSP quote | Good for **DMARC reports only**, if we don't self-host `rua`. |
| **HetrixTools** | Blocklist monitoring only. | Documented v2 API (add, list, update monitors). | Free; $9.95–$99.95/mo | Cheap fallback for blocklists only. |

No vendor gives a Gmail **reputation score** any more, because Google retired
it. Vendors that show one compute their own from blocklists, spam traps, complaints
and seed tests. Treat any vendor score as that vendor's opinion, labeled with its
source.

**Verified Mailgun Optimize API surface** (from its published OpenAPI spec,
59 paths, read 2026-11-24):
- Register and manage assets: `POST/GET/PUT/DELETE /v1/inboxready/ip_addresses[/{ip}]`,
  `POST/GET/DELETE /v1/inboxready/domains`, `PUT /v1/inboxready/domains/verify`.
- Blocklists: `/v1/monitoring/domains`, `/v1/monitoring/domains/{domain}/blocklists`,
  `/v1/monitoring/domains[/{domain}]/events`, HBL monitoring `/v1/monitoring/hbls`.
- Google Postmaster: `/v1/reputationanalytics/gpt/domains[/{domain}]` (daily
  records), `/v1/reputationanalytics/gpt/domainsfbl`, v2 compliance
  `/v2/reputationanalytics/gpt/compliances[/{domain}]`.
- Microsoft SNDS: `/v1/reputationanalytics/snds[/{ip}]`.
- Spam traps: `/v1/spamtraps`, `/v2/spamtraps`, totals and filters.
- DMARC reports: `/v1/dmarc/domains/{domain}` down to `/s/{source}/h/{host}/ip/{ip}`.
- Inbox placement: `/v4/inbox/seedlists`, `/v4/inbox/tests`, `/v4/inbox/results`.
- Alerts: `/v1/alerts/settings[/events]` (add, update, remove), `/v1/alerts/events`,
  outbound **webhooks with a signing key** (`/v1/alerts/settings/webhooks/signing_key`,
  `/v1/alerts/webhooks/test`), Slack and email.
- Email Health Score (`/v1/maverick-score/*`) appears to score Mailgun-sent
  traffic. Don't rely on it for SendGrid mail.

Plan limits: Starter ($99/mo) monitors only **1 IP and 1 domain** for blocklists
and spam traps, 1 domain for Postmaster and 1 IP for SNDS. Several newsletters
need the **Contract** tier (custom price). Get a quote for our asset count.

Also reviewed and rejected as the primary backend:
- **EasyDMARC**: strong DMARC API (74 endpoints), but reputation and blocklist
  monitoring is UI-only, with no Postmaster, SNDS or webhooks documented.
- **Tatami** ($10 per million emails, first 100 IPs free): ingests SendGrid
  events and watches 100+ blocklists every 6 hours, but has no API to register
  assets or read status. Alerts go to Slack, Discord or email only.
- **Postmaster+**, **MailerSend**, **HetrixTools**: blocklist-only APIs.
- **unspam.email**: no blocklist monitoring.

**Decision:**
1. **Mailgun Optimize (Contract tier, sized to our IPs and domains)** as the
   external signal backend: IP and domain blocklists, spam traps, Postmaster,
   SNDS, DMARC reports and signed alert webhooks. Start on the Starter trial to
   build and verify the adapter against one IP and one domain. Our adapter
   registers our IPs and domains with it and reads status back.
2. **First-party rates** we already compute stay a core signal, especially for
   shared IPs.
3. **DNS posture checks** stay in-house: they're simple and free, and they need
   to know our own expected records.
4. **DMARC `rua`**: use Optimize's DMARC reports API first; self-host only if it falls short.
5. **GlockApps** only if we want cheaper or broader seed tests. Trial its API first.

What we still build: the asset registry, one adapter per vendor (the
`HealthSource` interface below), health roll-up, and the publisher and
newsletter views. Collection, list maintenance and Postmaster/SNDS plumbing are
the vendor's job.

## Existing foundation (keep and extend)

- `SendingIp` (publisher-scoped address, status, limits, warm-up schedule),
  `SendingPool`, `SendingPoolIp`, `SendingPoolBinding`, `NewsletterRoute`
  (newsletter to connection and pool) and `NewsletterSend.ipId` (the IP each
  send actually used).
- `SendingConnection.senderDomains` and `NewsletterTrackingDomain`.
- `getPublisherDeliveryHealth`: first-party per-IP and per-newsletter rates.
- Publisher settings already have **Sending**, **IP pools** and
  **Tracking domains** tabs, and Reports already calls `/delivery-health`.

Gaps: `SendingIp` has no provider, provider account, or dedicated/shared kind.
There is no domain registry spanning sender, return-path, DKIM and tracking
domains. There is no health storage or external signal source.

## Design

### 1. Asset registry (Postgres)

- **Provider account**: provider (`sendgrid`, `ses`, `telnyx`, `smtp`),
  publisher, display name, encrypted credentials (reuse `newsletterSecrets`),
  read-only flag.
- **IP**: extend `SendingIp` with `providerAccountId`,
  `kind: dedicated | shared | unknown`, `providerIpRef`, `ptrHostname`,
  `ptrVerified`, `firstSeenAt`, `lastSeenAt`, `source: synced | manual`.
  Shared IPs are inventoried for display only: a shared provider pool is one
  "shared" row, or several rows when the provider reports them.
- **Domain**: new `DeliverabilityDomain`: domain, publisher, and
  `roles[]: from | return_path | dkim | tracking | link`, verification state per
  source (Postmaster verified, CFL enrolled, `rua` configured).
- **Associations** (derived, not duplicated):
  - newsletter to IPs: `NewsletterRoute` to pool to `SendingPoolIp`, plus
    historical `NewsletterSend.ipId`.
  - newsletter to domains: `SendingConnection.senderDomains`, plus the
    newsletter tracking domain, plus registry roles.

### 2. Signal sources (adapters)

Each source implements one interface:

```ts
interface HealthSource {
  id: "first_party" | "dns_posture" | "dnsbl" | "google_postmaster"
    | "microsoft_snds" | "dmarc_rua" | "yahoo_cfl" | "sendgrid_inventory"
    | "ses_inventory";
  covers: ("ip" | "domain")[];
  configSchema: TSchema;            // credentials and options, validated
  cadence: string;                  // e.g. hourly, daily
  collect(ctx): Promise<Observation[]>; // read-only; never mutates providers
}
```

- Inventory sources (SendGrid, SES) **upsert the registry**. Every other source
  only **emits observations**.
- Every source is **off by default** per publisher, with its own credentials,
  last-run time, last error and data freshness.
- All sources are read-only. Provider writes stay behind the existing
  `allowProviderWrites` / `allowIpReassignment` gates and are out of scope here.

### 3. Observations and health (ClickHouse + Postgres)

- `deliverability_observations` (ClickHouse, append-only): asset type and id,
  source, metric, value, status, observed-at, raw reference. History for charts.
- `DeliverabilityHealth` (Postgres, latest per asset per source):
  `status: good | warning | critical | unknown`, key metrics, `observedAt`,
  `staleAfter`.
- **Roll-up**: the asset's overall status is the worst current source status.
  Stale or missing data shows as **unknown**, never as good. Each status shows
  which source drove it.
- Thresholds are versioned config, not hardcoded, because they will be tuned.
  Starting points: Gmail spam rate warning at 0.1%, critical at 0.3% (Google's
  published bulk-sender limit); hard-bounce and complaint thresholds per IP
  from first-party data; any major-list DNSBL listing is critical; SNDS
  yellow is warning and red is critical; a failing compliance check is warning.

### 4. Scheduling (Temporal)

One scheduled workflow per enabled source per publisher, in the existing
worker:

- DNS posture and blocklists: hourly, plus on demand.
- Provider inventory: daily, plus on demand.
- Postmaster and SNDS: daily (their data lags 1–2 days).
- DMARC `rua` and Yahoo CFL: continuous, from an inbound mailbox.

Inbound reports (`rua`, CFL) use Cloudflare Email Routing to a Worker, which
posts to an authenticated ingest API. This follows the tracking Worker pattern.

### 5. UI

**Publisher level**: a new top-level **Deliverability** item beside
Newsletters, Subscribers, Reports and Publisher settings.
- **Overview**: counts of IPs by provider and dedicated/shared; health counts
  (good, warning, critical, unknown); domains by health; recent changes.
- **IPs**: address, provider and account, dedicated/shared, pool, newsletters
  using it, warm-up stage, PTR, blocklists, SNDS, 7-day bounce and complaint
  rates, overall status and its source.
- **Domains**: domain, roles, newsletters, SPF/DKIM/DMARC, Gmail spam rate and
  compliance, DBL, DMARC pass rate, overall status.
- **Sources**: each source's enabled state, credentials status, last run,
  freshness and errors. Configuration lives here.

**Newsletter level**: a **Deliverability** subsection inside an opened
newsletter that shows the same tables filtered to that newsletter's
associations, plus its own first-party rates. Read-only. Configuration stays at
publisher level.

The existing Publisher settings **IP pools** tab stays the place to manage
routing. Deliverability links to it rather than duplicating it.

### 6. API and MCP

`/api/admin/deliverability/*` read endpoints (overview, IPs, domains, sources,
newsletter-scoped views), registered through the shared controller so the
workspace API and MCP generate read-only tools automatically. Source
configuration endpoints are write-scoped. No raw credentials are returned.

### 7. Code layout

`packages/backend-lib/src/deliverability/`: `registry.ts`, `health.ts`,
`thresholds.ts`, `sources/{firstParty,dnsPosture,dnsbl,googlePostmaster,microsoftSnds,dmarcRua,yahooCfl,sendgridInventory,sesInventory}.ts`,
`workflows.ts`. Dashboard: `components/deliverability/*`. The module can be
disabled per publisher without affecting sending.

## Phases

- [ ] **0. Accounts and decisions (Carson)**: start a Mailgun Optimize trial
  (Starter); connect Google Postmaster and SNDS inside Optimize; verify sending
  domains in Google Postmaster; register dedicated IPs in SNDS; list current IPs
  per provider and whether each is dedicated.
- [ ] **1. Registry and overview**: schema additions, SendGrid inventory sync
  (read-only), domain registry derived from connections and tracking domains,
  the publisher and newsletter Deliverability views using first-party rates
  only. Unknown is shown honestly.
- [ ] **2. Mailgun Optimize adapter**: register our IPs and domains, read
  blocklist, spam-trap, Postmaster and SNDS status, and receive its alert
  webhooks. Replaces building our own DNSBL, Postmaster and SNDS collectors.
- [ ] **3. DNS posture checks** (in-house): SPF, DKIM, DMARC, MTA-STS, TLS-RPT,
  PTR/FCrDNS against our expected records.
- [ ] **4. Fallbacks only if the vendor falls short**: direct Google Postmaster
  v2 or SNDS ingestion, or HetrixTools for blocklists.
- [ ] **5. DMARC `rua` and Yahoo CFL ingestion**: inbound mailbox, parsing,
  per-source-IP alignment.
- [ ] **6. SES inventory and CloudWatch reputation** (only if SES is used).
- [ ] **7. Alerts and operations** (later): health-change alerts to Better
  Stack, warm-up and delisting runbooks.

## Open questions

- Current IP inventory per provider, and which IPs are dedicated.
- Whether Telnyx exposes sending IPs at all. If not, treat Telnyx as shared and
  unknown.
- Spamhaus DQS versus HetrixTools, depending on cost and the number of lists.
- Whether `rua` reports should go to our own ingest or to a DMARC vendor.

## Sources

- [Google: Migrate to Postmaster Tools API v2](https://developers.google.com/workspace/gmail/postmaster/guides/migration-v2)
- [Google: deprecation of the old Postmaster Tools interface](https://support.google.com/mail/answer/16594218?hl=en)
- [Google: domains.getComplianceStatus](https://developers.google.com/workspace/gmail/postmaster/reference/rest/v2/domains/getComplianceStatus)
- [Google: domains.domainStats.query](https://developers.google.com/workspace/gmail/postmaster/reference/rest/v2/domains.domainStats/query)
- [Microsoft SNDS 2026 guide (Warmy)](https://www.warmy.io/blog/email-deliverability/microsoft-snds-outlook-deliverability/)
- [Microsoft SNDS and JMRP after migration (SMTPedia)](https://smtpedia.com/microsoft-snds-jmrp/)
- [Yahoo Complaint Feedback Loop](https://senders.yahooinc.com/complaint-feedback-loop)
- [Yahoo Sender Hub FAQ](https://senders.yahooinc.com/faqs)
- [Spamhaus: commercial data FAQ](https://www.spamhaus.org/faqs/commercial-data/)
- [Spamhaus: migrating to DQS](https://docs.spamhaus.com/datasets/docs/source/70-access-methods/data-query-service/015-migrating-to-dqs.html)
- [HetrixTools blacklist monitor pricing](https://hetrixtools.com/pricing/blacklist-monitor/)
- [SendGrid: retrieve all IP addresses](https://docs.sendgrid.com/api-reference/ip-address/retrieve-all-ip-addresses)
- [SendGrid: IP warm-up](https://docs.sendgrid.com/api-reference/ip-warmup/start-warming-up-an-ip-address)
- [SendGrid: dedicated IP addresses](https://twilio.com/docs/sendgrid/ui/account-and-settings/dedicated-ip-addresses.md)
- [Amazon SES: managed dedicated IPs](https://docs.aws.amazon.com/ses/latest/dg/managed-dedicated-sending.html)
- [Amazon SES: IP observability for managed dedicated IPs](https://aws.amazon.com/about-aws/whats-new/2025/10/amazon-ses-ip-observability-dedicated-op-addresses-managed/)
- [Amazon SES pricing](https://aws.amazon.com/ses/pricing/)
- [Mailgun Optimize APIs overview](https://documentation.mailgun.com/docs/inboxready/onboarding-ir)
- [Mailgun Optimize: IP blocklist monitoring API](https://documentation.mailgun.com/docs/inboxready/ip-blocklist-ir)
- [Mailgun Optimize: domain blocklist monitoring API](https://documentation.mailgun.com/docs/inboxready/openapi-final/tag/Domain-Blocklist-Monitoring)
- [Mailgun Optimize pricing](https://www.mailgun.com/pricing/optimize/)
- [Mailgun release notes](https://www.mailgun.com/releases/)
- [GlockApps API](https://glockapps.com/api-documentation-v2/)
- [GlockApps pricing](https://glockapps.com/pricing/)
- [GlockApps Postmaster Tools v2 integration](https://glockapps.com/blog/glockapps-google-postmaster-tool-integration/)
- [Inbox Monster reputation monitoring](https://inboxmonster.com/sender-reputation)
- [Inbox Monster: Postmaster and SNDS integration](https://intercom.help/inbox-monster/en/articles/5742909-integrate-google-postmaster-tools-and-microsoft-snds)
- [Validity Everest review 2026](https://mailflowauthority.com/monitoring-analytics/validity-everest-review)
- [Suped integrations](https://www.suped.com/integrations)
- [Suped pricing](https://www.suped.com/pricing)
- [HetrixTools blacklist monitor API](https://docs.hetrixtools.com/tag/blacklist-monitor-api)
- [Mailgun Optimize API reference (OpenAPI spec)](https://documentation.mailgun.com/docs/inboxready/api-reference/optimize/inboxready)
- [Mailgun Optimize: Microsoft SNDS integration](https://www.mailgun.com/blog/product/optimize-sending-with-microsoft-snds-integration/)
- [EasyDMARC API](https://easydmarc.com/platform/dmarc/api)
- [EasyDMARC reputation monitoring](https://easydmarc.com/tools/reputation-monitoring)
- [Tatami](https://tatamimonitor.com/)
- [Postmaster+](https://postmasterplus.com/)
