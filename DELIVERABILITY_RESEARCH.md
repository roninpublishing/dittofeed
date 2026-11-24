# Deliverability (IP and domain health): research notes

Status: **research in progress. No decisions have been made.** Nothing here
chooses a vendor, approves a build, or authorizes provider changes, purchases or
email sends. These notes are for Carson and the agents continuing the research.

Last updated 2026-11-24.

## What Carson wants

- A system for **IP management** and **domain health**, built as modular pieces.
- A high-level overview of **all IPs across all providers**, whether each is
  **dedicated or shared**, and its **health**.
- Domain health, with **Google Postmaster Tools** likely as the domain-side
  integration.
- Two views:
  - **Publisher level** (above the newsletters): everything.
  - **Newsletter level**: only the IPs and domains associated with that newsletter.
- Planning and integration first. Operational procedures (warm-up, delisting,
  incident handling) come later.
- Preference: **don't reverse-engineer what a tool already does.** Ideally one
  service whose API lets us register IPs and domains, read status and history,
  and receive alerts, with our own views on top.

## Key findings

1. **Google retired the domain and IP reputation scores.** Postmaster Tools v2
   (UI and API) doesn't include them. Google says the v2 API "will encompass all
   existing v1 functionality, except Domain and IP reputation." No retirement
   dates are published, and v1 (`trafficStats`) is being retired. Any
   "reputation score" a vendor shows is its own estimate.
2. **No single source gives IP reputation.** IP health has to be pieced together
   from first-party bounce and complaint rates, Microsoft SNDS (dedicated IPs
   only), blocklists, PTR/rDNS, and authentication posture.
3. **Gmail health is now domain-based**: spam rate plus compliance status.
4. **Shared IPs** can only be judged by our own rates, blocklists and provider
   status. SNDS can't register shared-pool IPs.
5. **SendGrid gives inventory, not health.** Its API lists IPs, pools, subusers,
   warm-up and rDNS, but Twilio leaves dedicated-IP reputation monitoring to the
   customer.

## Signal sources

| Source | Covers | Provides | Access and limits |
|---|---|---|---|
| **Google Postmaster Tools API v2** (GA Feb 3, 2026) | Domains | `domains.domainStats.query`: spam rate, feedback-loop spam rates, SPF/DKIM/DMARC success, TLS rates, delivery errors. `domains.getComplianceStatus`: SPF, DKIM, DMARC policy and alignment, one-click unsubscribe, honoring unsubscribes, each `COMPLIANT` or `NEEDS_WORK`, plus a deliverability verdict since June 24, 2026. | OAuth scopes `postmaster` or `postmaster.traffic.readonly`. DNS-verified domains (DKIM `d=` or SPF Return-Path domain). Only domains sending to 50+ Gmail users a day get data. Domain-level only; no per-IP data found. Data lags about a day. Unclear whether a service account can be used (users are managed per domain via `domains.users`). |
| **Microsoft SNDS** | IPs | Per-IP filter result (green/yellow/red), complaint rate, volume at Outlook.com/Hotmail/Live/MSN | Dedicated IPs only. Data only on days with 100+ messages to Microsoft consumer domains. New portal (substrate.office.com); old automated-access links deprecated June 22, 2026. Trap-hit counts removed July 22, 2026. One guide mentions a future OAuth REST API (unverified). Doesn't cover Microsoft 365 tenants. |
| **Yahoo Sender Hub** | Domains | Complaint Feedback Loop (CFL), ARF reports by email, DKIM-domain based. Insights dashboard. | No public reporting API. CFL arrives as email; Insights is UI-only. |
| **Blocklists** | IPs and domains | Listing status | Spamhaus: free Data Query Service is for non-commercial, low-volume use only; commercial use needs a paid annual subscription (30-day free trial; price not published). ZEN for IPs, DBL for domains. Spamhaus blocks queries through public resolvers. |
| **DNS posture** | IPs and domains | SPF, DKIM, DMARC, MTA-STS, TLS-RPT, BIMI, PTR/forward-confirmed rDNS | Plain DNS lookups. No vendor needed. |
| **DMARC aggregate reports (`rua`)** | Domains, plus every IP sending as them | Who sends as the domain, pass/fail per source IP | Self-host (parsedmarc-style) or a vendor. |
| **SendGrid API** | IPs and domains | `GET /v3/ips` (assigned/unassigned, warm-up, pools, subusers, rDNS), `/v3/ips/pools`, warm-up endpoints, domain authentication | No reputation endpoint. |
| **Amazon SES** | IPs and domains | Managed dedicated IPs: per-ISP reputation and SNDS metrics as CloudWatch metrics (since Oct 2025). VDM: per-provider delivery, bounce and complaint rates. | VDM Global deliverability (adds hourly blocklist checks) is $1,250/month per region. Only relevant if SES is used. |
| **First-party (already in the app)** | IPs, newsletters | Per-IP and per-newsletter sent, delivered, bounced, dropped, spam-report, open and click counts from signed SendGrid webhooks (`getPublisherDeliveryHealth`) | Our own observations. The strongest signal for shared IPs. |

## Vendors reviewed

### Mailgun Optimize

The strongest API found. It works with other ESPs, including SendGrid, per
Mailgun's FAQ.

- **Verified from its published OpenAPI spec** (59 paths):
  - Register assets: `POST/GET/PUT/DELETE /v1/inboxready/ip_addresses[/{ip}]`,
    `POST/GET/DELETE /v1/inboxready/domains`, `PUT /v1/inboxready/domains/verify`.
  - Blocklists: `/v1/monitoring/domains`, `/v1/monitoring/domains/{domain}/blocklists`,
    events endpoints; HBL (email address) monitoring `/v1/monitoring/hbls`.
    Lists include Spamhaus, CBL, SpamCop (IP) and Spamhaus DBL, URIBL, SURBL (domain).
  - Google Postmaster: `/v1/reputationanalytics/gpt/domains[/{domain}]` (daily
    records), `/domainsfbl`, v2 compliance `/v2/reputationanalytics/gpt/compliances[/{domain}]`.
  - Microsoft SNDS: `/v1/reputationanalytics/snds[/{ip}]`.
  - Spam traps: `/v1/spamtraps`, `/v2/spamtraps`, totals and filters.
  - DMARC reports: `/v1/dmarc/domains/{domain}` down to `/s/{source}/h/{host}/ip/{ip}`.
  - Inbox placement: seed lists, tests, results (`/v4/inbox/*`).
  - Alerts: `/v1/alerts/settings[/events]` (add/update/remove), `/v1/alerts/events`,
    **outbound webhooks with a signing key**, Slack, email.
  - Email Health Score (`/v1/maverick-score/*`): appears to score Mailgun-sent
    traffic. Unclear whether it's useful for SendGrid mail.
- **Pricing**: Pilot $49/mo (no monitoring); Starter $99/mo, which monitors only
  **1 IP and 1 domain** for blocklists and spam traps, 1 domain for Postmaster and
  1 IP for SNDS; Contract is custom ("monitor a custom number of domains and IP
  addresses"). No per-IP or per-domain rate is published anywhere found.

### GlockApps

- Seed tests across 30+ providers, Google Postmaster v2 data and alerts,
  blocklist and IP reputation monitors, DMARC analytics, DNS checks.
- Hosted MCP server, but its tools only cover inbox tests, not Postmaster or DMARC.
- API is said to be on every plan, including free (`x-api-key`). **Endpoint
  reference didn't render, so it's unverified.**
- Pricing: Free; Essential $59/mo (10 IP reputation monitors); Growth $99/mo (20);
  Enterprise "Agencies" $129/mo (25). DMARC message quotas per tier.
- SNDS not mentioned.

### Inbox Monster

- Pulls Google Postmaster v2, Microsoft SNDS and the Spamhaus domain reputation
  feed into one dashboard, plus blocklists and seed tests. ESP-neutral.
- **No public API documentation found.** Quote-only pricing.

### Validity Everest

- The most complete: Sender Score, domain and IP reputation trends, 200+
  blocklists, Postmaster and SNDS, Universal Feedback Loop, seed tests.
- API on enterprise tiers only. Third-party pricing estimates range from
  roughly $20k to $100k+ a year (Vendr cites about $36.8k list for Professional).

### Suped

- DMARC report processing, hosted SPF/DKIM/DMARC/MTA-STS/BIMI, blocklists,
  Postmaster (not for MSP organizations), email and webhook alerts.
- Narrow API: one read-only REST endpoint (DMARC records). MCP adds
  organizations, domains and issues. API on Enterprise and MSP plans only.
- Pricing: Free; Business about $19–24/mo; Enterprise and MSP by quote.

### EasyDMARC

- Strong DMARC API (74 endpoints: DNS lookup, aggregate and failure reports,
  domains, batch domain creation).
- Reputation and blocklist monitoring is UI-driven: daily checks and email
  alerts, but no documented API, Postmaster, SNDS or webhooks.
- DMARC Plus $35.99/mo, Premium $71.99/mo; Deliverability (with reputation
  monitoring) and Enterprise (API) by quote.

### Tatami (by Bento)

- Ingests the SendGrid Event Webhook and watches Google, Yahoo and Microsoft
  signals plus 100+ blocklists (checked every 6 hours).
- **No API for registering assets or reading status.** Alerts go to Slack,
  Discord or email; there's an MCP server.
- $10 per million emails, first 100 IPs free, all features on every plan.
  Not covered by Bento's SOC 2 report.

### Blocklist-only services

- **HetrixTools**: documented v2 API to add, list and update monitors. Free;
  $9.95–99.95/mo (Personal is 256 monitors).
- **MXToolbox**: paid monitoring roughly $129–399/mo; webhook on listing.
- **Postmaster+**: blocklist API.
- **MailerSend**: blocklist monitoring API.
- **ZeroBounce**: 1 free monitor.
- **unspam.email**: no blocklist monitoring.

## Rough cost scenarios: 20 IPs and 10 domains (unquoted)

| Option | Monthly | Notes |
|---|---|---|
| Mailgun Optimize Contract | **Unknown** | Needs a sales quote |
| GlockApps Growth | ~$99 | 20 IP monitors; API unverified |
| HetrixTools + Postmaster v2 + SNDS directly | ~$10 | Postmaster and SNDS ingestion built in-house |
| Tatami | ~$0–30 | No API |
| Validity Everest | $2k+ | Enterprise |

## Build-it-ourselves effort (rough estimates)

| Piece | Effort | Notes |
|---|---|---|
| Registry, health roll-up, publisher and newsletter views | ~1–2 weeks | Needed under **every** option |
| DNS posture checks | 1–2 days | |
| Blocklist checks | 1–2 days | Spamhaus needs a paid key and a private resolver; a blocklist API avoids both |
| Google Postmaster v2 ingestion | 2–3 days | OAuth plus daily pull; one-time DNS verification per domain |
| Microsoft SNDS ingestion | ~1 day | CSV pull; one-time manual IP registration |
| DMARC `rua` processing | 3–5 days | Inbound mail, unzip, XML parsing, storage |
| Alerts | 1–2 days | |
| Spam-trap monitoring | **Not buildable** | Needs a trap network |
| Inbox placement seed tests | **Not realistically buildable** | Needs seed mailboxes across many providers |

Rough totals: fully custom about 3–4 weeks plus ongoing upkeep (Google and
Microsoft both changed these interfaces in 2026). With a single vendor API, about
1.5–2.5 weeks (registry, views, one adapter).

## What already exists in the app

- `packages/backend-lib/src/db/publisherSchema.ts`:
  - `sendingIp` (publisher-scoped address, status, limits, warm-up schedule)
  - `sendingPool`, `sendingPoolIp`, `sendingPoolBinding`
  - `newsletterRoute` (newsletter → connection + pool)
  - `newsletterSend` (records `ipId` per send)
  - `sendingConnection.senderDomains`
  - `newsletterTrackingDomain`
  - `publisherSendgridAccount`, with write, IP-reassignment and real-send gates
    all off by default
- `packages/backend-lib/src/newsletterInfrastructure.ts`: the SendGrid client
  already reads `/ips?subuser=`, `/ips/pools` and `/whitelabel/domains`.
- `packages/backend-lib/src/newsletterReporting.ts`: `getPublisherDeliveryHealth`
  (first-party per-IP and per-newsletter counts), served at `/delivery-health`.
- Dashboard: publisher navigation is Newsletters, Subscribers, Reports and
  Publisher settings. Settings tabs include Sending, IP pools and Tracking domains.
- Gaps: no provider or dedicated/shared fields on IPs, no domain registry
  across roles (from, return-path, DKIM, tracking), no health storage, no
  external signals.

## Options on the table (undecided)

- **A. Mailgun Optimize as the single signal backend.** Best API coverage
  (register assets, all signals, signed webhooks, spam traps, seed tests).
  Unknown cost at our asset count.
- **B. Hybrid.** Our own registry and views; Postmaster v2, SNDS and DNS checks
  built in-house; HetrixTools for blocklists. Cheapest known cost; no spam traps
  or seed tests; more upkeep.
- **C. GlockApps.** Mid-price with broad coverage, but its API needs verification.
- **D. Fully custom**, including our own blocklist checks with a Spamhaus
  commercial key.
- Any option can add a separate DMARC source (Suped, EasyDMARC or self-hosted)
  and a seed-test vendor later.

## Open questions and next research

- Mailgun Optimize Contract quote for about 20 IPs and 10 domains. Does the
  Email Health Score work for non-Mailgun traffic?
- GlockApps: get a trial key and confirm real endpoints for monitors, Postmaster
  data, blocklist history and alerts/webhooks. Does it cover SNDS?
- Inbox Monster: is there an API at all?
- Spamhaus commercial DQS pricing for our query volume.
- SNDS: does the new portal offer a REST/OAuth API, or only CSV links? How often
  do the links expire?
- Google Postmaster v2: can a service account access domains, or must it be a
  user? Full metric list (`MetricDefinition` enum).
- Telnyx: does it expose sending IPs, dedicated or shared?
- Current inventory: which IPs exist per provider, and which are dedicated.
- DMARC reports: a vendor, Mailgun's endpoint, or self-hosted?
- Other vendors not yet checked: Warmy, Folderly, MailReach, Palisade,
  PowerDMARC (webhook alerts mentioned), Red Sift, Valimail, Sendmarc.

## Sources

- [Google: Migrate to Postmaster Tools API v2](https://developers.google.com/workspace/gmail/postmaster/guides/migration-v2)
- [Google: deprecation of the old Postmaster Tools interface](https://support.google.com/mail/answer/16594218?hl=en)
- [Google: domains.getComplianceStatus](https://developers.google.com/workspace/gmail/postmaster/reference/rest/v2/domains/getComplianceStatus)
- [Google: domains.domainStats.query](https://developers.google.com/workspace/gmail/postmaster/reference/rest/v2/domains.domainStats/query)
- [Google: Gmail API release notes](https://developers.google.com/workspace/gmail/release-notes)
- [Postmaster Tools v2 changes (unspam)](https://unspam.email/articles/google-postmaster-tools)
- [Microsoft SNDS 2026 guide (Warmy)](https://www.warmy.io/blog/email-deliverability/microsoft-snds-outlook-deliverability/)
- [Microsoft SNDS and JMRP after migration (SMTPedia)](https://smtpedia.com/microsoft-snds-jmrp/)
- [Yahoo Complaint Feedback Loop](https://senders.yahooinc.com/complaint-feedback-loop)
- [Yahoo Sender Hub FAQ](https://senders.yahooinc.com/faqs)
- [Spamhaus: commercial data FAQ](https://www.spamhaus.org/faqs/commercial-data/)
- [Spamhaus: free Data Query Service](https://www.spamhaus.com/data-access/free-data-query-service/)
- [Spamhaus: migrating to DQS](https://docs.spamhaus.com/datasets/docs/source/70-access-methods/data-query-service/015-migrating-to-dqs.html)
- [SendGrid: retrieve all IP addresses](https://docs.sendgrid.com/api-reference/ip-address/retrieve-all-ip-addresses)
- [SendGrid: IP warm-up](https://docs.sendgrid.com/api-reference/ip-warmup/start-warming-up-an-ip-address)
- [SendGrid: dedicated IP addresses](https://twilio.com/docs/sendgrid/ui/account-and-settings/dedicated-ip-addresses.md)
- [Amazon SES: managed dedicated IPs](https://docs.aws.amazon.com/ses/latest/dg/managed-dedicated-sending.html)
- [Amazon SES: IP observability for managed dedicated IPs](https://aws.amazon.com/about-aws/whats-new/2025/10/amazon-ses-ip-observability-dedicated-op-addresses-managed/)
- [Amazon SES: Global deliverability](https://docs.aws.amazon.com/ses/latest/dg/vdm-global-deliverability.html)
- [Amazon SES pricing](https://aws.amazon.com/ses/pricing/)
- [Mailgun Optimize APIs overview](https://documentation.mailgun.com/docs/inboxready/onboarding-ir)
- [Mailgun Optimize API reference (OpenAPI spec)](https://documentation.mailgun.com/docs/inboxready/api-reference/optimize/inboxready)
- [Mailgun Optimize: IP blocklist monitoring](https://documentation.mailgun.com/docs/inboxready/ip-blocklist-ir)
- [Mailgun Optimize: domain blocklist monitoring](https://documentation.mailgun.com/docs/inboxready/openapi-final/tag/Domain-Blocklist-Monitoring)
- [Mailgun Optimize: Google Postmaster Tools API](https://documentation.mailgun.com/docs/inboxready/api-reference/optimize/inboxready/google-postmaster-tools)
- [Mailgun Optimize: SNDS integration](https://www.mailgun.com/blog/product/optimize-sending-with-microsoft-snds-integration/)
- [Mailgun Optimize pricing](https://www.mailgun.com/pricing/optimize/)
- [Mailgun Optimize pricing breakdown (Mailmend)](https://mailmend.io/blogs/mailgun-optimize-pricing)
- [Mailgun release notes](https://www.mailgun.com/releases/)
- [GlockApps API](https://glockapps.com/api-documentation-v2/)
- [GlockApps pricing](https://glockapps.com/pricing/)
- [GlockApps Postmaster Tools v2 integration](https://glockapps.com/blog/glockapps-google-postmaster-tool-integration/)
- [Inbox Monster reputation monitoring](https://inboxmonster.com/sender-reputation)
- [Inbox Monster: Postmaster and SNDS integration](https://intercom.help/inbox-monster/en/articles/5742909-integrate-google-postmaster-tools-and-microsoft-snds)
- [Validity Everest review 2026](https://mailflowauthority.com/monitoring-analytics/validity-everest-review)
- [Validity Everest pricing (unspam)](https://unspam.email/alternatives/validity-everest)
- [Suped integrations](https://www.suped.com/integrations)
- [Suped pricing](https://www.suped.com/pricing)
- [EasyDMARC API](https://easydmarc.com/platform/dmarc/api)
- [EasyDMARC reputation monitoring](https://easydmarc.com/tools/reputation-monitoring)
- [EasyDMARC pricing](https://easydmarc.com/pricing)
- [Tatami](https://tatamimonitor.com/)
- [HetrixTools blacklist monitor pricing](https://hetrixtools.com/pricing/blacklist-monitor/)
- [HetrixTools blacklist monitor API](https://docs.hetrixtools.com/tag/blacklist-monitor-api)
- [Postmaster+](https://postmasterplus.com/)
- [MailerSend blocklist monitoring API](https://developers.mailersend.com/api/v1/blocklist-monitoring)
- [Deliverability monitoring tools for developers (Mailer To Go)](https://resources.mailertogo.com/listicle/best-email-deliverability-monitoring-tools-developers)
