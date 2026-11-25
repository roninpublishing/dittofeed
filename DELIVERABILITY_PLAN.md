# Deliverability Health System: Architecture Spec

Nov 24, 2026 · Carson

## Summary

We build one Deliverability system in three layers: **See** (every IP and domain, every signal), **Decide** (a health state per asset per mailbox provider, with reasons), and **Act** (warm-up, volume caps, routing, and automatic pullback). SendGrid and Telnyx are the two sending providers. Google Postmaster v2, Microsoft SNDS, PowerDMARC, DNS checks and our own event data are the signal sources.

_The system architecture diagram (see, decide, act), the Open tracking tab and the KPI framework tab live in the source doc and still need to be added to this repository before tracking or KPI work starts._

## Codebase alignment (read first)

This spec was checked against the fork on Nov 25, 2026. Build on what exists; don't duplicate it.

- **Neither provider has sent a real email yet.** SendGrid newsletter sending is built and tested locally with mocks. Telnyx email works only through the basic workspace email-provider path (`destinations/telnyx.ts`, `messaging.ts`). It has no accounts, IPs, pools, gates or capacity budgets.
- **Real sends can't be switched on.** Every newsletter send requires `allowRealSends` and `allTrafficControlled` on its `PublisherSendgridAccount`. Both default to false, and no API, screen or command sets them; the admin API rejects `allowRealSends: true`. An approved enable path is a prerequisite, not part of this spec.
- **Routing is a per-send ESP choice, not `NewsletterRoute`.** In-progress work replaces `NewsletterRoute` with `NewsletterDefault` plus a per-send `EspSelection` (account, pool or IP). The choice and its candidate IPs are saved on each `NewsletterSend` and checked again before submission (`verifyPinnedNewsletterSelection`). The router in this spec produces `EspSelection`s; it doesn't add a route table.
- **One account model.** Multi-instance ESP accounts are being built on `PublisherSendgridAccount` + `SendingConnection`. Generalize that model to cover Telnyx; don't add a parallel `providerAccount` table. Coordinate with that work before changing these tables.
- **Caps and warm-up already exist.** `SendingIp` has `hourlyLimit`, `dailyLimit`, `warmupStartedAt` and `warmupSchedule`. `newsletterCapacityLimits` and `reserveCapacity` (with `SendingIpBudget`) enforce them per physical IP (`canonicalIpId`). The warm-up planner and volume governor extend these.
- **Delivery data already exists.** Signed SendGrid webhook receipts (`NewsletterWebhookReceipt`, `receiveNewsletterWebhook`), suppressions (`PublisherSuppression`, `NewsletterSuppression`) and `getPublisherDeliveryHealth` / `getNewsletterDeliveryHealth`. The send-events adapter reads from these.
- **Open tracking already exists.** Owned pixel (`messaging/openTracking.ts`, `/api/public/email/open/<token>.gif`), the relay Worker (`packages/tracking-worker`), per-newsletter tracking domains (`NewsletterTrackingDomain`, `newsletterTracking*.ts`), and the protected `last_opened` / `last_clicked` contact properties. The tracker in this spec extends these (see Open and click tracking).
- **Events live in ClickHouse.** Contact events, opens and clicks are stored in ClickHouse (`userEvents/clickhouse.ts`). High-volume tables (`trackingEvent`, `eventRollupHourly`, `signalObservation`) go in ClickHouse; registry, states, rules, incidents and approvals go in Postgres (Neon).
- **Naming.** The UI is now Workspace → Newsletters. "Publisher" below means the workspace; database columns keep `publisherId`. Contacts are Dittofeed users: use `userId` wherever this spec says subscriber.
- **Cloudflare.** Every Worker, Queue and KV goes in the RONIN account (`2c0f822ce2342b56b3998e7981c03332`), never ADVERTISE.

Every source writes into one signal store. Only the health engine judges, and every control decision reads its states. Send events from SendGrid and Telnyx come back in as the first source.

The system stays easy to use by following five rules:

- **States, not scores.** Every asset is Healthy, Watch, At risk or Critical. A reason sentence and a suggested action always sit next to the state. Raw numbers appear one click deeper.
- **One place to look.** A "Needs attention" list ranked by sending volume affected. If it's empty, nothing needs you.
- **Per mailbox provider.** Gmail, Microsoft, Yahoo and Apple judge us separately, so health and routing are tracked per provider. One bad Gmail day shouldn't pull an IP off Microsoft traffic.
- **Same view at two levels.** The publisher view shows everything. The newsletter view is the same screen filtered to that newsletter's assets.
- **Automation with guardrails.** The system can slow down or reroute on its own. Anything that adds risk (new IPs, raising caps, moving a newsletter to a new domain) needs approval. The existing send and IP-reassignment gates stay in force.

The registry and health engine come first. Every later piece (warm-up, routing, alerts) reads from them.

## Asset registry

The registry is the single list of everything we send from. Every signal, health state and routing decision attaches to a registry row. It builds on the existing `PublisherSendgridAccount`, `SendingConnection`, `SendingIp`, `SendingPool`, `SendingPoolIp`, `NewsletterDefault` and `NewsletterTrackingDomain` tables. It extends them and doesn't replace them.

| Asset | Key fields | Source of truth |
| --- | --- | --- |
| Provider account | provider (sendgrid, telnyx), account or subuser, region, credentials ref; extends `PublisherSendgridAccount` / `SendingConnection` | Our config |
| IP | address, provider, **dedicated or shared**, pool, region, rDNS/PTR, SNDS-registered flag, lifecycle state, warm-up plan | Provider inventory sync + our lifecycle |
| Pool | provider, purpose (warm-up, engaged, bulk, cold, transactional), member IPs | Ours, mirrored to the provider |
| Domain | root domain, **role** (from, return-path, DKIM `d=`, tracking, link), parent domain, provider verification, Postmaster verification, DMARC policy, lifecycle state | Ours + DNS + Postmaster |
| Sending identity | from-domain + return-path + DKIM domain + tracking domain, bound to a provider connection | Ours |
| Route | newsletter default (`NewsletterDefault.selection`) + per-send `EspSelection` (account, pool or IP), with optional weights | Existing default/selection model, extended |

**Shared IPs** are stored as one row per provider pool, not per address. We can't list or register a provider's shared addresses, so their health comes only from our own rates and blocklist hits on addresses we actually observe in the logs.

**Subdomains are first-class.** Each newsletter (or group of newsletters) gets its own sending subdomain under a root, such as `news.brand.com`, plus its own return-path and tracking subdomains. That keeps one newsletter's problems from spreading. The registry links each subdomain to its root, so root-level problems (blocklisted domain, DMARC changes) flow down to every child.

**Lifecycle states** apply to IPs and sending domains:

| State | Meaning | Can receive traffic |
| --- | --- | --- |
| Provisioning | Bought or created, DNS or PTR not confirmed | No |
| Warming | On a warm-up plan with daily caps | Engaged users only, capped |
| Active | Fully warmed, normal routing | Yes |
| Throttled | Reduced caps after a health warning | Yes, reduced |
| Quarantined | Pulled after a Critical state; sends only recovery traffic | Recovery only |
| Retired | Released or parked | No |

State changes are logged with who or what made them (person, rule, provider sync). Lifecycle extends the existing `SendingIp.status` (`active` / `paused`); `paused` maps to Provisioning or Retired. The newsletter view filters on the route graph: newsletter → default and per-send selections → accounts → pools → IPs and domains, plus the IPs actually used (`NewsletterSend.ipId`, `actualIp`).

## Signal ingestion

Each source is one adapter. Every adapter writes the same normalized row: **asset, mailbox provider, metric, value, period, source, observed at**. The health engine only ever reads those rows, so adding or swapping a source never touches health logic.

| Adapter | Assets | What it gives | Cadence | Notes |
| --- | --- | --- | --- | --- |
| Send events (SendGrid + Telnyx webhooks) + our tracker | IP, domain, newsletter, segment | sent, delivered, bounced (hard/soft), deferred, dropped, spam reports and unsubscribes from the providers; classified opens and clicks from our own tracker | Real time, rolled up hourly | Strongest signal. The only signal for shared IPs. Reads existing `NewsletterWebhookReceipt` / `NewsletterSend` (SendGrid) and `messaging/telnyxEvents.ts` (Telnyx); doesn't add a second webhook receiver. |
| Bounce and deferral parser | IP, domain | Block/throttle reasons per mailbox provider (Gmail rate-limit and policy codes, Microsoft and Yahoo block codes) | Real time | **Earliest warning.** Blocks show up here hours before Postmaster or SNDS. |
| Mailbox-provider classifier | All | Maps each recipient domain to Gmail, Microsoft, Yahoo, Apple or other **by MX lookup**, not just by `gmail.com` | Cached per recipient domain | Catches Google Workspace and Microsoft 365 business addresses. |
| Google Postmaster v2 | Domain | Spam rate, FBL spam rates, SPF/DKIM/DMARC pass, TLS, delivery errors, compliance status | Daily (`batchQuery`) | Data only for 50+ Gmail recipients a day. Domain registration and verification are scripted. |
| Microsoft SNDS | Dedicated IP | Filter result (green/yellow/red), complaint rate, volume | Daily | OAuth REST API. Dedicated IPs only. |
| PowerDMARC | IP, domain | Blocklist listings (200+ lists) via webhook; DMARC aggregate data | Webhook + daily | HetrixTools is the fallback if its monitors can't be managed by API. |
| DNS posture checker | Domain, IP | SPF, DKIM, DMARC policy, PTR + forward-confirmed rDNS, MTA-STS, TLS-RPT, BIMI | Every 6 hours + on change | In-house, no vendor. |
| Inventory sync | IP, pool, domain | Provider IP list, pools, warm-up state, domain auth status (SendGrid `/v3/ips`, Telnyx `/v2/email/dedicated_ips`) | Hourly | Flags drift: an IP at the provider that we don't know about, or the reverse. |
| Yahoo CFL | Domain | Complaint reports (ARF emails) | Real time | Phase 3. Parse emails sent to a dedicated inbound address. |

**Gaps no adapter fills:** spam-trap hits and inbox placement. These need a vendor (Mailgun Optimize or a seed-test service) if we want them later.

## Open and click tracking

**Existing tracking this extends:** the owned open pixel (`messaging/openTracking.ts`, path `/api/public/email/open/<43-char token>.gif`, encrypted request/outbox, retention and erasure), the relay Worker `packages/tracking-worker`, per-newsletter tracking domains (`NewsletterTrackingDomain`, Cloudflare provisioning in `newsletterTrackingCloudflare.ts`), and the protected `last_opened` / `last_clicked` contact properties. The new classifier, click redirect and queue are added to `packages/tracking-worker` and the existing pixel route. Pixel tokens already in sent mail keep working. Classified events also update `last_opened` / `last_clicked`, counting only human events.

**Decision change required:** `FORK_PLAN.md` currently records "no click redirect" and "no automatic href rewriting". Click tracking below reverses both. It needs Carson's explicit approval, and `FORK_PLAN.md` must be updated when approved. Until then, build opens and the classifier only.

We run our own open and click tracking on each newsletter's tracking domain, instead of SendGrid's and Telnyx's. One classifier then works for both providers, and every hit carries a class (human, proxy, prefetch, scanner, self, unknown), a reason, and whether it counts. The design follows the open-source project `yuriyward/mail-tracker`. The full rule set, IP sources and research are in the Open tracking tab of the source doc.

**Using mail-tracker:** we own this repository and use its code as the base, adapted for bulk newsletter sending. Keep as is: the classifier (`src/classify.ts`), the published-network lookup (`src/networks.ts`) and its refresh script (`scripts/refresh-networks.ts`), the Gmail proxy and delivery-prefetch rules, and the Worker's pixel and redirect routes. Replace: per-draft registration and D1 token rows (one-to-one features), the Mailspring plugin, the compose CLI, and the personal dashboard. The table below lists each change.

### What we keep and what we change for bulk

| Piece | mail-tracker | Adaptation |
| --- | --- | --- |
| Runtime | Cloudflare Worker (Hono, TypeScript) | Existing `packages/tracking-worker`, RONIN Cloudflare account |
| Tokens | Random token per recipient, stored in D1 before sending | **Signed, stateless tokens**: HMAC-SHA256 over send ID, user ID, kind and link index, base64url. No row per recipient and nothing to register before sending. Keys rotate with a key ID in the token. Existing open-pixel tokens stay valid. |
| Link destinations | Stored per token | Stored once per send (`sendLink`); the token carries the link index |
| Event writes | One D1 row per hit | Respond first, then `waitUntil` → Cloudflare Queue → batch consumer → ClickHouse `trackingEvent` |
| Classifier | Pure function, ordered rules | Use classify.ts as is, same constants (10 s click, 3 s burst, 30 s open, 30 s duplicate), plus `isbot` and an "every link clicked" rule |
| IP lists | JSON file regenerated by script, then redeploy | Run refresh-networks.ts as a weekly scheduled Worker that writes a versioned set to KV instead of a committed file; alert if a source fails or shrinks > 20% |
| Gmail delivery prefetch (±30 s) | Applied when read | Applied in the hourly rollup |
| Preload and forwarding hints | Yes | Dropped: one-to-one features |
| Self and draft previews | Owner's IPs, Access login, draft tokens | Staff IP list, seed inboxes, test-send flag |

### Request flow

1. **At send**, the renderer rewrites every body link to `https://<tracking domain>/c/<token>` (only once the click-redirect decision is approved) and adds one image on the existing pixel path, `https://<tracking domain>/api/public/email/open/<token>.gif`, with empty alt text and no class or style (filters look for those).
2. **The Worker** checks the HMAC. An open returns a 1×1 GIF with `Cache-Control: no-store`. A click returns a 302 to the stored destination. A bad token on a click goes to the newsletter's home page, so the endpoint is never an open redirect.
3. **After responding**, the Worker sends IP, user agent, network owner (`request.cf.asOrganization`), country, method and time to the queue. The pixel and the redirect never wait on a database.
4. **The consumer** looks up the delivery time from the provider events and works out seconds since delivery and recent clicks by the same actor. It then classifies and inserts in batches.
5. **Hourly rollups** count only counted events, per newsletter × mailbox provider × engagement tier × IP and domain.

### Rules that must hold

- **Provider tracking stays off.** Turn off open and click tracking on every SendGrid subuser and Telnyx domain (Telnyx is off by default), so nothing is counted twice.
- **Tracking domains are assets.** Each one sits in the registry, has DNS and blocklist checks (a DBL listing of a tracking domain hurts every email that uses it), and is unique per newsletter or newsletter group.
- **Privacy.** Keep raw IP and user agent 30 days, then null them. Keep class, reason, network owner and country.
- **Versioned rules.** Each event stores the rules version that classified it. Raw rows allow reclassifying old events after a rule change.

### What it feeds

Per event: `class`, `reason`, `counted`. Per contact (Dittofeed user): `mppUser` (opens come only through Apple's relay, so judged on clicks only), `hasRealOpen`, last human open and click. Per newsletter × mailbox provider: human open rate (non-MPP recipients only), human click rate, MPP share, unknown share. These drive the engagement tiers and the Tier 3 KPIs.

## Health engine

The engine gives each **asset × mailbox provider** pair one of four states: Healthy, Watch, At risk or Critical. Every state carries the rules that set it, written as plain sentences, plus a suggested action. Example: "At risk at Gmail: spam rate 0.22% yesterday (limit 0.3%). Suggest: send only to engaged users for 3 days."

Rules are data, not code: one versioned table of thresholds that can be changed per publisher. Starting defaults:

| Signal | Watch | At risk | Critical |
| --- | --- | --- | --- |
| Gmail spam rate (Postmaster) | ≥ 0.1% | ≥ 0.2% | ≥ 0.3% (Google's limit) |
| Complaint rate (our events, per provider) | ≥ 0.08% | ≥ 0.15% | ≥ 0.3% |
| Hard bounce rate | ≥ 1% | ≥ 2% | ≥ 5% |
| Block or deferral rate at a provider (parser) | ≥ 2% | ≥ 5% | ≥ 15%, or any policy block |
| SNDS filter result | Yellow 1 day | Yellow 3+ days | Red |
| Blocklist | Minor list | Barracuda, SpamCop, CBL | Spamhaus SBL, XBL or DBL |
| Postmaster compliance | — | Any `NEEDS_WORK` | DMARC or auth failing |
| DNS posture | Optional record missing (MTA-STS, BIMI) | PTR mismatch, SPF near 10 lookups | SPF, DKIM or DMARC broken |
| Human open-rate drop vs 14-day baseline (machine opens excluded) | ≥ 25% drop | ≥ 40% drop | — |

The complaint, bounce, deferral and open-drop numbers above are starting points to tune once we have our own baselines.

**Minimum volume:** a rate only counts once the asset has at least 500 sends to that mailbox provider in the window. Below that, the state is "Not enough data" instead of a guess.

**Roll-ups:** IP → pool → provider account; subdomain → root domain; newsletter = its route graph; publisher = everything. A parent takes the worst child state, weighted by the share of volume that child carries. One Critical IP with 2% of the traffic makes its pool Watch, not Critical. Root-domain problems (a DBL listing, broken DMARC) push down to every child.

**History:** one snapshot per asset per day, plus a log of every state change and its reasons. That log drives the timeline on each asset's page and the warm-up gates.

**Not a reputation score.** Google no longer publishes domain or IP reputation, so we don't invent one. States come from signals we can explain.

## Control plane

The control plane turns health into sending decisions. It runs before every send batch. It answers: **which recipients, through which provider, pool, IP and subdomain, and how many today.**

### Engagement tiers

Every subscriber gets a tier, recomputed daily from human clicks and human opens as classified by our tracker. Machine opens and bot clicks never count, and Apple MPP users are judged on clicks only:

| Tier | Rule (default) | Used for |
| --- | --- | --- |
| Hot | Clicked or opened in the last 14 days | Warm-up traffic, recovery traffic |
| Engaged | Last 30 days | Normal sends |
| Lapsing | 31–90 days | Normal sends, capped share on weak assets |
| Cold | 91–180 days | Isolated cold pool only, small caps |
| Sunset | 180+ days, or new with no engagement after N sends | Suppressed or re-permission flow |
| New | Signed up in the last 14 days | Separate tracking so bad signup sources show up fast |

Signup source is kept on every subscriber. A source with high bounce or complaint rates is flagged like any other asset.

### Warm-up planner

- One plan per new IP **and** per new sending subdomain. Each plan is a day-by-day cap **per mailbox provider**, starting with Hot users only.
- A plan moves to the next step only if the asset was Healthy at every provider yesterday. Watch means hold the current step. At risk means go back one step. Critical means pause and quarantine.
- **Our planner is the source of truth.** Provider auto-warm-up (SendGrid's, Telnyx's) is turned off or matched to our plan, so two schedules never fight each other.
- **Builds on the existing schedule.** `SendingIp.warmupStartedAt` / `warmupSchedule` (steps by days since start) and `newsletterCapacityLimits` already apply warm-up caps per IP. Extend them with per-mailbox-provider caps and health-gated stepping (hold or step back), rather than replacing them.
- Warm-up plans are templates (for example, conservative 30-day or standard 21-day) that can be cloned and edited.

### Volume governor

The governor sets hourly and daily caps per **IP × mailbox provider** and **subdomain × mailbox provider**. It also limits day-over-day growth (default +20%) on Active assets. Caps come from the asset's warm-up step, or from the last 30 days' steady volume for Active assets, lowered by its health state: Throttled is 50% of normal, Quarantined is recovery traffic only. Mail over the cap waits for the next window. It never spills onto another asset without a routing decision.

The governor extends the existing admission path: `reserveCapacity` charges each message to every candidate IP's physical budget (`SendingIpBudget`, keyed by `canonicalIpId`) and defers with "Capacity deferred" when full. Health multipliers, per-mailbox-provider windows and growth limits are added there.

### Routing and load balancing

For each batch the router:

1. Starts from the newsletter's route: allowed sending identities and pools.
2. Splits recipients by mailbox provider and engagement tier.
3. For each slice, picks eligible IPs and subdomains: Healthy or Watch at that mailbox provider, with cap room left, and tier allowed for its pool.
4. Spreads volume across them by weight. Weight = remaining cap × health factor (Healthy 1.0, Watch 0.6). Sticky assignment keeps a recipient on the same IP and subdomain from send to send, so mailbox providers see a consistent sender.
5. Holds anything with no eligible asset and raises an alert. It never falls back to a riskier asset silently.

Routing across providers (SendGrid vs Telnyx) works the same way, because each provider's pools are just more eligible assets. Weights per newsletter can be pinned by hand.

**Output is an `EspSelection`.** The router's result for each slice is the existing per-send selection (account, pool or IP) and its candidate IP list. These are saved on the `NewsletterSend` and verified again before submission, so a queued retry never re-routes. Routing never changes the selection of a send that's already queued. Cross-provider routing needs Telnyx on the newsletter path first (see Codebase alignment).

### Automatic actions and approval gates

| Action | Trigger | Default |
| --- | --- | --- |
| Hold warm-up step / step back | Watch / At risk | Automatic |
| Throttle asset at one mailbox provider | At risk | Automatic |
| Engaged-only mode for an asset | At risk at any provider | Automatic |
| Quarantine asset at a provider, reroute its volume | Critical | Automatic, notify immediately |
| Raise caps, end quarantine, promote Warming → Active | Recovery for N days | **Approval** |
| Add or buy IPs, add subdomains, move a newsletter to a new identity | Person starts it | **Approval** |
| Delist requests, provider tickets | Blocklist or block | Draft for a person |

What the system does on its own only ever lowers risk. Anything that adds risk needs a person. The existing `PublisherSendgridAccount` gates (`allowProviderWrites`, `allowIpReassignment`, `allowRealSends`, plus `allTrafficControlled`) still apply on top. Telnyx gets the same gates once it has a newsletter-path account. Automation never sets these gates.

## Alerts and incidents

Alerts fire on **state changes**, not on every reading, so one bad hour doesn't send 40 messages.

- **Critical:** sent right away to Slack and email, with the asset, the mailbox provider, the reason, what the system already did automatically, and a link to the asset page.
- **At risk:** sent right away to Slack, batched by asset.
- **Watch:** goes into a daily digest only.
- **Not-enough-data and recoveries:** go into the daily digest.

An open problem on an asset becomes an **incident**: one record with a timeline of signals, automatic actions, notes and approvals until the asset is Healthy for 3 days in a row. Repeat alerts attach to the open incident instead of creating new ones. Step-by-step playbooks (delisting, recovering a quarantined asset) come later, as the notes planned. Each playbook will attach to an incident type.

Routing rules per publisher decide who gets what. Alerts also go out as signed webhooks, so other agents and tools can subscribe.

## UI

Add **Deliverability** as an item in the workspace left sidebar (`/dashboard/workspace`), alongside the planned Overview, Newsletters, ESP accounts, IPs, IP pools, Subscribers, Reports and Settings. Each newsletter gets a **Deliverability** tab showing the same screens, filtered. The workspace IPs and IP pools screens being built for multi-account ESP show the deliverability state columns, rather than this spec adding a second IP list. Setup (warm-up templates, thresholds, alert routing) lives under workspace Settings. Infrastructure stays at workspace level, never inside a newsletter.

| Screen | What's on it | Answers |
| --- | --- | --- |
| Overview | Count of assets in each state; the **Needs attention** list ranked by volume affected, each row with its reason and a one-click action; a grid of assets × mailbox providers colored by state | "Is anything wrong, and what do I do?" |
| IPs | Every IP: provider, dedicated or shared, pool, lifecycle, state per mailbox provider, today's volume vs cap, warm-up day | "What do we own and how is each one doing?" |
| Domains | Root domains with their subdomains nested; roles, DNS posture, Postmaster status, state per mailbox provider | "Which domains are healthy and set up right?" |
| Asset page | Current state and reasons; a timeline of signals and state changes; warm-up progress; routing share; incident history; actions (throttle, quarantine, change caps) | "Why is this asset in this state, and what has happened?" |
| Warm-up | Every warming asset: current step, next step, held or stepped back and why, days to Active | "Where is each new IP and domain in its ramp?" |
| Routing | Today's planned and actual volume by newsletter → provider → pool → IP, split by mailbox provider and tier; held volume | "Where is mail going right now?" |
| Incidents | Open and closed incidents with their timelines | "What went wrong and what was done?" |
| Approvals | Pending risk-adding actions with the evidence for each | "What is waiting on me?" |

On every screen, the state and its reason come first. Numbers and charts are one click down. Every action button says what it will do and what it can be undone with.

## Data model

Postgres tables sit beside `publisherSchema.ts` (Drizzle migrations). High-volume tables go in ClickHouse (marked **CH**). Existing tables are extended, not replaced. Every table is scoped to a workspace (`publisherId` / `workspaceId`).

| Table | Purpose | Key columns |
| --- | --- | --- |
| `SendingIp` (extend) | IPs | + `ipType` (dedicated, shared\_pool), `lifecycleState`, `ptr`, `sndsRegistered`, `warmupPlanId`. Provider and account come from the existing `accountId`. |
| `PublisherSendgridAccount` / `SendingConnection` (extend, shared with the multi-ESP work) | Provider accounts and subusers | + `provider` (sendgrid, telnyx); existing gate flags stay |
| `sendingDomain` | Every domain and subdomain | `name`, `parentId`, `role[]`, `lifecycleState`, `postmasterStatus`, `dmarcPolicy`; links existing `NewsletterTrackingDomain` rows |
| `sendingIdentity` | from + return-path + DKIM + tracking bundle | domain ids per role, `accountId` |
| `NewsletterDefault` / `EspSelection` (extend) | Newsletter default and per-send choice | + optional `weight`, `pinned` |
| `mailboxProviderMap` | Recipient domain → mailbox provider | `recipientDomain`, `mxHost`, `mailboxProvider`, `checkedAt` |
| `contactEngagement` | Tier per contact | `userId`, `tier`, `lastEngagedAt`, `signupSource`, `stickyIpId`, `stickyDomainId` |
| `signalObservation` (CH) | Normalized readings from every adapter | `assetType`, `assetId`, `mailboxProvider`, `metric`, `value`, `periodStart`, `periodEnd`, `source` |
| `eventRollupHourly` (CH) | First-party counts | asset, newsletter, mailbox provider, tier, hour, counts by event type |
| `healthRule` | Versioned thresholds | `metric`, `watch`, `atRisk`, `critical`, `minVolume`, `version` |
| `healthState` | Current state per asset × mailbox provider | `state`, `reasons` (JSON), `since` |
| `healthSnapshotDaily` | History | asset, mailbox provider, day, state, key metrics |
| `stateChange` | Audit log for health and lifecycle | asset, from, to, `actor` (rule, user, sync), reasons |
| `warmupPlan` / `warmupStep` | Templates and per-asset plans | day, cap per mailbox provider, tiers allowed |
| `SendingIp` limits + `SendingIpBudget` (extend) | Live caps | existing hourly/daily limits and budgets; + per-mailbox-provider caps and health multiplier, reason |
| `routingDecision` | Per-batch plan and outcome | batch, slices, assets chosen, held volume |
| `incident` / `incidentEvent` | Incidents and their timelines | asset, opened, closed, events |
| `approvalRequest` | Risk-adding actions waiting on a person | action, evidence, requested by, decision |
| `blocklistListing` | Listing history | asset, list, listed at, delisted at |

`signalObservation` and `eventRollupHourly` are the heavy tables. Store them in ClickHouse, partitioned by month, with 13 months of history (an assumption: change it if you want longer).

**Tracking tables:**

| Table | Purpose | Key columns |
| --- | --- | --- |
| `sendLink` | Link destinations per send, so tokens carry only an index | `sendId`, `linkIndex`, `url`, `linkText` |
| `trackingEvent` (CH) | Every pixel and link hit, raw and classified | `sendId`, `userId`, `newsletterId`, `kind` (open/click), `linkIndex`, `occurredAt`, `ip` and `userAgent` (nulled after 30 days), `asnOrg`, `country`, `method`, `secondsSinceDelivery`, `class`, `reason`, `counted`, `rulesVersion` |
| `networkRangeSet` | Versions of the published IP lists | `source` (apple, google, microsoft, mimecast, proofpoint), `fetchedAt`, `blockCount`, `kvKey`, `status` |
| `trackingKey` | HMAC signing keys | `keyId`, `createdAt`, `retiredAt` (the secret itself lives in Worker secrets) |
| `contactEngagement` (extend) | Flags from tracking | + `mppUser`, `hasRealOpen`, `lastHumanOpenAt`, `lastHumanClickAt` |

`trackingEvent` is the largest table in the system. It goes in ClickHouse, partitioned by month, next to the existing event tables.

## Build order

There are three phases. Each one is usable on its own, and each needs the one before it. Phase 1 only watches. Nothing in it changes how mail is sent.

0. **Prerequisites (outside this spec).**
   - The multi-account ESP and per-send selection work lands on `main`, so this builds on the final account and selection model.
   - An approved, audited way to enable real sends on an account.
   - Telnyx on the newsletter send path (account, IPs, gates, capacity) before any Telnyx-specific item below. Until then, Telnyx items are limited to inventory sync and webhook signals.
   - The source doc's architecture diagram, Open tracking tab and KPI framework tab added to this repository.
1. **Phase 1: See (visibility).**
   1. Registry: extend the existing account, IP, pool and tracking-domain tables; add `sendingDomain`, `sendingIdentity`.
   2. Inventory sync for SendGrid and Telnyx, plus drift detection.
   3. Mailbox-provider classifier and hourly event rollups (SendGrid + Telnyx webhooks), plus our own open tracker in `packages/tracking-worker`: signed tokens, queue, classifier and weekly IP-list refresh, adapted from the mail-tracker code. Click redirects only after the decision change is approved. Starts collecting engagement baselines from day one.
   4. Bounce and deferral parser.
   5. DNS posture checker.
   6. Postmaster v2 adapter, including scripted domain verification.
   7. SNDS adapter.
   8. PowerDMARC adapter (blocklists + DMARC), or HetrixTools as the fallback.
   9. Health engine, rules table, roll-ups, daily snapshots.
   10. Screens: Overview, IPs, Domains, Asset page; Critical and At-risk alerts.
   - **Done when:** every IP and domain we send from shows a state per mailbox provider with reasons, and the state for one test asset matches a manual check. Test-inbox sends (Apple Mail with and without MPP, Gmail, Outlook.com, Yahoo, a Microsoft 365 tenant) come back classified correctly.
2. **Phase 2: Decide and route (control).**
   1. Engagement tiers and signup-source tracking.
   2. Warm-up planner and templates.
   3. Volume governor.
   4. Router with sticky assignment, running in **shadow mode** first: it logs what it would do next to what actually happened.
   5. Warm-up, Routing and Approvals screens.
   - **Done when:** the router's shadow-mode plans match what we would have done by hand, then is switched on one newsletter at a time.
3. **Phase 3: Act on its own (automation).**
   1. Automatic actions from the gate table: throttle, engaged-only mode, quarantine and reroute.
   2. Incidents, digests, outbound alert webhooks.
   3. Yahoo CFL parsing; DMARC source-IP view.
   4. Optional vendors for spam traps and seed tests, if gaps show up.
   - **Done when:** a simulated Critical (forced test state) throttles, reroutes and alerts correctly from start to finish.

## Decisions needed and items to verify

**Decisions for Carson:**

- [ ] Approve this design as the plan for Phase 1.
- [ ] Approve click redirects and link rewriting (reverses the "no click redirect / no automatic href rewriting" decision in `FORK_PLAN.md`).
- [ ] How real sends get enabled on an account: who can do it, and how it's recorded.
- [ ] Bring Telnyx onto the newsletter send path, or keep Phase 1–2 SendGrid-only?
- [ ] Blocklist source: PowerDMARC (blocklists + DMARC in one) or HetrixTools (cheaper, documented API)? Depends on the PowerDMARC check below.
- [ ] Which automatic actions run without approval in Phase 3 (the gate table's defaults, or stricter)?
- [ ] Subdomain scheme: one sending subdomain per newsletter, or per newsletter group?
- [ ] Data retention for heavy tables (13 months assumed).
- [ ] Spam traps and seed tests: skip for now, or budget for a vendor?

**Verify before building:**

- [ ] Telnyx Email event webhooks: which events exist (bounce, deferral, spam report, open, click), and are they signed?
- [ ] Telnyx dedicated IP warm-up: can provider auto-warm-up be turned off or set by us?
- [ ] SendGrid automatic warm-up is off for every dedicated IP.
- [ ] PowerDMARC: can blocklist monitors be created and read through its API? Webhook payload format, and pricing for our asset count.
- [ ] Postmaster v2: can a service account be added as a READER and read stats? Pull the full metric enum.
- [ ] SNDS: Microsoft's official REST endpoints and how to register the OAuth app.
- [ ] Current inventory: every IP and domain at SendGrid and Telnyx, dedicated or shared, and which newsletter uses each.

**Tracking:**

- [x] Cloudflare account for the tracking Worker, Queue and KV: RONIN (`2c0f822ce2342b56b3998e7981c03332`), never ADVERTISE.
- [ ] Migration for existing open-pixel tokens and `last_opened` / `last_clicked` data when the classifier goes live.
- [ ] Approve 30-day retention for raw IPs and user agents, and update the privacy policy.
- [ ] Legal review before adding hidden honeypot links (US patent 12,489,787).
- [ ] Turn off SendGrid and Telnyx open and click tracking once our tracker is live, and confirm nothing is counted twice.

KPIs, thresholds and the monitoring system: see the KPI framework tab of the source doc.
