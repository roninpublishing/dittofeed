# Developer brief: open tracking classifier and event pipeline

You are building the first slice of the deliverability system's own open tracking in the Ronin Publishing fork of Dittofeed. Read this whole brief, then `DELIVERABILITY_PLAN.md` (section "Open and click tracking"), then `AGENTS.md`, before changing anything.

## Goal

Every hit on our open pixel gets a class (human, apple_proxy, gmail_proxy, prefetch, scanner, self, unknown), a reason and a `counted` flag, and lands in a ClickHouse `trackingEvent` table, without slowing the pixel response. This gives us human open rates per newsletter and mailbox provider, which later feed engagement tiers and health states.

This slice covers **opens only**. Click redirects and link rewriting are not approved (they reverse a recorded decision in `FORK_PLAN.md`). Don't build them, and don't add a `/c/` route.

## What already exists (read this code first)

| Piece | Where | What it does today |
| --- | --- | --- |
| Pixel issuance | `packages/backend-lib/src/messaging/openTracking.ts` (`prepareEmailOpenTracking`) | Per-send random 32-byte token, stored hashed and encrypted in `emailOpenTrackingSend` (Postgres). Adds the pixel `/api/public/email/open/<43-char token>.gif` to the HTML. Called from `messaging.ts`. |
| Edge relay | `packages/tracking-worker/src/index.ts` | Cloudflare Worker on `dt.<domain>` hostnames. Validates the path, builds an evidence envelope (bounded headers, edge IP, TLS/HTTP version), HMAC-signs it and **synchronously** POSTs it to the backend relay. It returns the GIF only after the backend answers 204; otherwise 503. Disabled unless `ENABLED=true`. |
| Backend capture | `packages/api/src/controllers/openTrackingController.ts` → `captureEmailOpenRequest` | Verifies the relay signature, looks up the token hash, stores an encrypted receipt in `emailOpenTrackingReceipt`. |
| Event projection | `drainEmailOpenEvents` (global cron workflow) | Turns receipts into `DFEmailOpened` events in ClickHouse; enforces `openTrackingRetentionDays`; erasure via `deleteEmailOpenData` and tombstones. |
| Contact properties | `builtinUserProperties.ts`, computed properties | Protected `last_opened` / `last_clicked` from event occurrence time. |
| Tracking domains | `NewsletterTrackingDomain`, `newsletterTracking*.ts` | Per-newsletter `dt.` hostnames, Cloudflare provisioning. |
| Config | `config.ts` | `enableOpenTracking`, `openTrackingRetentionDays`. |
| Worker config | `packages/tracking-worker/wrangler.jsonc` | RONIN account `2c0f822ce2342b56b3998e7981c03332`, `workers_dev: false`, `ENABLED=false`. |

Reference implementation to adapt: `yuriyward/mail-tracker` (we own it). Reuse `src/classify.ts`, `src/networks.ts`, `scripts/refresh-networks.ts`, and the Gmail proxy and delivery-prefetch rules. Don't bring over D1 token rows, the Mailspring plugin, the compose CLI or its dashboard. If you can't access the repository, stop and say so; don't reimplement it from memory.

## Scope

**In scope**

1. **Classifier module.** Port `classify.ts` as a pure, deterministic function with the same constants (10 s click, 3 s burst, 30 s open, 30 s duplicate), plus `isbot` user-agent detection. Output `{ class, reason, counted, rulesVersion }`. Put it where both the Worker and the backend can import it, or in the backend if that's the only caller (decide and explain in your design note).
2. **Published network lists.** Port `networks.ts` and `refresh-networks.ts` (Apple, Google, Microsoft, Mimecast, Proofpoint ranges). Run the refresh as a weekly scheduled Worker that writes a versioned set to KV. Fail loudly (keep the previous set) if a source fails or shrinks by more than 20%.
3. **Respond-first Worker.** Change the Worker to return the GIF immediately for a well-formed token on a branded hostname, then hand the evidence to a Cloudflare Queue with `ctx.waitUntil`. Add network owner (`request.cf.asOrganization`), ASN, country and the matched published-network set to the envelope. Keep every existing guard: hostname and path validation, header bounds, no reflection of errors, no forwarded client headers, `ENABLED` kill switch.
4. **Queue consumer → backend.** Batch queue messages and deliver them to a new signed batch endpoint on the backend (same HMAC scheme as the existing relay, timestamped, replay-limited). The backend stays the only writer to Postgres and ClickHouse.
5. **Classification and storage in the backend.** For each hit: resolve the token, look up delivery time for that send from provider events where available, compute seconds since delivery and recent hits by the same actor, classify, and insert in batches into a new ClickHouse `trackingEvent` table (monthly partitions). Columns: `workspaceId`, `messageId`/send ID, `userId`, `newsletterId`, `kind` (`open`), `occurredAt`, `ip`, `userAgent`, `asnOrg`, `country`, `method`, `secondsSinceDelivery`, `class`, `reason`, `counted`, `rulesVersion`.
6. **Keep the existing pipeline working.** Existing tokens and the `DFEmailOpened` projection keep working. Decide whether `DFEmailOpened` / `last_opened` should be emitted only for `counted` hits; propose it in the design note, don't switch it silently.
7. **Privacy.** Null raw `ip` and `userAgent` after 30 days (ClickHouse TTL or scheduled mutation). Keep class, reason, network owner and country. Erasure (`deleteEmailOpenData`) must also remove the user's `trackingEvent` rows.

**Out of scope**

- Click redirects, link rewriting, `/c/` routes, `sendLink`.
- Stateless HMAC pixel tokens. The current random tokens stay. Note in your design note whether stateless tokens would still be worth it later.
- Hourly rollups, engagement tiers, health states and dashboard screens.
- Any change to the send path. **Do not edit** `messaging.ts`, `newsletterDelivery.ts`, `broadcasts*`, `journeys.ts`, `db/publisherSchema.ts` or `drizzle/meta`. Another agent is actively changing them. If you need something from them, write it down as a hand-off item instead.

## How to approach it

1. **Set up an isolated worktree.** Branch `feat/tracking-classifier` off `origin/main` in its own folder (`git worktree add`). Never work in the main checkout: it has another agent's uncommitted changes.
2. **Write a short design note first** (`packages/tracking-worker/DESIGN.md`) covering:
   - where the classifier lives
   - the envelope v2 shape
   - the queue and batch-endpoint contract and its signature
   - how delivery time is looked up
   - the ClickHouse table DDL and TTL
   - how old relay traffic and the new path coexist during rollout
   - the `DFEmailOpened` / `last_opened` proposal

   Commit it before code.
3. **Build in this order**, each with tests:
   1. classifier and network lookup
   2. refresh job
   3. Worker respond-first and queue producer
   4. batch endpoint and backend classification
   5. ClickHouse table and inserts
   6. retention and erasure
4. **Port the mail-tracker tests with the code.** Add cases for Apple MPP, Gmail image proxy, delivery prefetch within ±30 s, security scanners (Mimecast, Proofpoint, Microsoft Defender), duplicate hits, bots by user agent, and a plain human open.
5. **Run an end-to-end test locally only.** Use `wrangler dev --local` or Miniflare, with a local queue, KV and backend: pixel request → GIF returned immediately → queue → batch endpoint → `trackingEvent` row with the expected class.

## Rules you must follow

- **No deploys.** Don't run `wrangler deploy`, don't create Cloudflare resources (Queues, KV, Workers, DNS) in any account, and don't change provider settings. Write the `wrangler.jsonc` bindings so they're ready, and list what must be created at deploy time. The account is always RONIN (`2c0f822ce2342b56b3998e7981c03332`), never ADVERTISE.
- **No email sends** of any kind, including test sends.
- **Databases:** never run tests against `dittofeed`, `dittofeed_dev` or the preview database. Jest teardown **drops** the configured ClickHouse and Postgres databases. Use `NODE_ENV=test` with throwaway `CLICKHOUSE_DATABASE` and `DATABASE_URL` names.
- **Tooling:** Yarn 4 (`node .yarn/releases/yarn-4.1.1.cjs`, since `yarn` isn't on PATH), Node 22. Config and secrets live only in the root `.env`; never print secret values, never commit `.env`, and don't create other env files.
- **Security posture of the Worker:** keep its fail-closed design: a bad hostname, path or token gets 404, never an error body or a redirect. Responding before the backend confirms means the Worker returns the GIF for any well-formed token. That's acceptable; validation moves to the backend, which drops unknown tokens.
- Don't merge to `main`. Push the branch and open a PR when done.

## Blocking inputs (ask the coordinator if missing)

- Access to the `yuriyward/mail-tracker` repository.
- The "Open tracking" tab from the deliverability source doc. It has the full classifier rule set and IP sources. If you don't have it, build from mail-tracker's rules and list every rule you had to assume.

## Done when

- The classifier and network lookup have unit tests covering every class listed above, all passing.
- The Worker returns the pixel without waiting on the backend, and existing Worker tests still pass, updated only where behavior changed on purpose.
- A local end-to-end run produces correctly classified `trackingEvent` rows for a human open, an Apple proxy open and a scanner hit.
- Existing open-tracking tests (`openTracking*.test.ts`, `openTrackingController`) still pass. Old tokens still produce `DFEmailOpened`.
- 30-day nulling of IP and user agent, and erasure of `trackingEvent` rows, are implemented and tested.
- Typecheck and lint pass for the touched packages.
- The PR description lists:
  - what changed
  - the design decisions made
  - the Cloudflare resources and secrets needed at deploy time
  - the hand-off items for the send path
  - every assumed classifier rule
