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

- [ ] **0. Accounts and decisions (Carson)**: verify sending domains in Google
  Postmaster; register dedicated IPs in SNDS; start a Spamhaus commercial trial
  or choose HetrixTools; pick the `rua`/CFL inbound address; list current IPs
  per provider and whether each is dedicated.
- [ ] **1. Registry and overview**: schema additions, SendGrid inventory sync
  (read-only), domain registry derived from connections and tracking domains,
  the publisher and newsletter Deliverability views using first-party rates
  only. Unknown is shown honestly.
- [ ] **2. DNS posture and blocklists**: SPF, DKIM, DMARC, MTA-STS, TLS-RPT,
  PTR/FCrDNS checks; DNSBL checks for IPs and domains.
- [ ] **3. Google Postmaster v2**: OAuth connection, domain stats and
  compliance status per verified domain.
- [ ] **4. Microsoft SNDS**: automated-access ingestion for dedicated IPs.
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
