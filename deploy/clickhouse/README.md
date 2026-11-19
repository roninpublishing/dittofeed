# Runbook Step 2 — production ClickHouse

This slice prepares **production**, not a separate staging environment. It does not
provision a Droplet/Spaces, configure Neon/Temporal/SendGrid, launch the full app,
or install anything on a live host. Do not create paid Spaces resources until the
owner approves the price and destination. No new app build is needed for this slice.

## Exact fork semantics

Use `docker-compose.lite.yaml`, not the development or EE compose files.

- `clickhouse/clickhouse-server:24.12.6.70-alpine` stays pinned.
- Existing `clickhouse_lib:/var/lib/clickhouse` and `clickhouse_log` volumes stay.
  **Never `down --volumes` on production.** Changing Compose project name selects
  different volumes; discover and retain the existing project's name.
- ClickHouse has **no host-published ports**. Internal service DNS remains
  `http://clickhouse-server:8123` on the shared Docker bridge. This means internal
  to Docker, not a Docker network with `internal: true`: production needs outbound
  HTTPS to Spaces. Local host/root and attached containers remain trusted.
- The existing env mapping already uses
  `${CLICKHOUSE_CONTAINER_MEM_LIMIT:-2048}m` in `deploy.resources.limits.memory`.
  `2048` resolves to 2147483648 bytes (2048 MiB); no new incompatible env mapping.
- The same credentials anchor feeds app, admin CLI and server. Password is now
  required at Compose interpolation (missing/empty fails closed).
- Leave `CLICKHOUSE_HOST` unset for the existing **Compose** default above.
- Do not set `CLICKHOUSE_DB` or precreate the production database here. The app's
  `packages/backend-lib/src/clickhouse.ts:createClickhouseDb` performs
  `CREATE DATABASE IF NOT EXISTS`; normal initial app bootstrap remains responsible
  for `dittofeed`. Backup intentionally fails if bootstrap has not happened.

## Private configuration on the approved production host

Prerequisites: exact approved host/SSH identity, root or equivalent Docker access,
Python 3 standard library, Docker Engine and Compose with `config --format json`.
Docker access is root-equivalent. Keep the checkout/code root-owned and non-writable
by untrusted users. The secret directory must be mode 0700, files 0600, owned by the
backup/cron user; backups refuse broader file permissions or another owner.

1. Retain the existing Compose project name and `.env`. Merge **only** settings
   from `.env.example` here into `/etc/dittofeed/.env` (or the existing canonical
   private env path). Do not overwrite other production settings. Generate the
   ClickHouse password privately with `openssl rand -hex 32` and paste it there;
   do not save it in Git, command arguments, chat, shell history or logs.
2. With cost approval, use/create the approved Spaces bucket. Grant a dedicated
   restricted backup key access only to that bucket/prefix as supported by Spaces.
   Save `spaces.example.json` privately as `/etc/dittofeed/spaces.json`, filling the
   regional HTTPS URL, bucket/prefix and keys. Example URL shape:
   `https://nyc3.digitaloceanspaces.com/approved-bucket/ch`.
   Credentials are JSON strings, **not shell code**. Region must match the bucket.
   Never enable a public-read bucket/ACL for backups.
3. Use the same env path/project for startup and backup. Once live-host writes are
   separately authorized, from the checkout (example `/opt/dittofeed`):

   ```sh
   # Replace PRODUCTION_PROJECT with the actual existing Compose project name.
   docker compose --project-name PRODUCTION_PROJECT --env-file /etc/dittofeed/.env \
     -f docker-compose.lite.yaml up -d --no-deps clickhouse-server
   ```

   This starts only ClickHouse, not the other services. Do not print full resolved
   Compose output: it contains credentials. If a volume already contains data or
   custom user configuration, inventory it and verify authentication before any
   credential rotation; this change is not a live password-rotation procedure.

## Native S3 backup and nightly cron

After normal app bootstrap has created the database, run one manual backup before
installing cron:

```sh
/usr/bin/python3 /opt/dittofeed/deploy/clickhouse/backup.py \
  --project-name PRODUCTION_PROJECT --env-file /etc/dittofeed/.env \
  --spaces-file /etc/dittofeed/spaces.json
```

The runner resolves the **actual Compose server credentials** in memory, runs
`BACKUP DATABASE dittofeed TO S3(...)` synchronously, and requires the exact
`BACKUP_CREATED` completion status. Password/client XML and SQL/S3 keys are streamed
through stdin, not argv. A private temporary client file exists only in the
container and is removed on shell exit. Server query logging is disabled for this
session. Administrators with Docker/server access can still access environment,
process memory and server-side state; this is not a boundary against root.
Client/Compose output is captured and suppressed on failure because it may contain
sensitive SQL. Do not enable shell tracing, verbose SQL logs or capture stdin.
Every attempt uses a UTC timestamp + UUID prefix: reruns never overwrite a backup.
A file lock prevents overlapping runner invocations sharing the secrets file.
Failures, missing database, permission errors, timeouts and unconfirmed completion
return nonzero, never a success message. A timeout can leave the server query
running: check `system.backups`/`system.processes` privately before retrying.

Create a root-owned 0600 log file at
`/var/log/dittofeed-clickhouse-backup.log`, and root-owned mode 0644
`/etc/cron.d/dittofeed-clickhouse` containing (replace project/path first):

```cron
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAILTO=""
# 03:17 nightly in the host's timezone (UTC only if the host is configured UTC).
17 3 * * * root /usr/bin/python3 /opt/dittofeed/deploy/clickhouse/backup.py --project-name PRODUCTION_PROJECT --env-file /etc/dittofeed/.env --spaces-file /etc/dittofeed/spaces.json >> /var/log/dittofeed-clickhouse-backup.log 2>&1
```

Cron and log files are **instructions only**, not installed by this change. Confirm
cron is active and observe the first scheduled success. Route failures/absence of
a nightly success to the owner's existing monitoring; `MAILTO=""` avoids accidental
email. Set log rotation with mode 0600. Before production signoff, verify bucket
private access, inspect backup objects, restore a selected backup into an isolated
non-production database and read actual data. Agree retention/lifecycle and restore
monitoring with the owner; no automatic object deletion is included.

## Reproducible local qualification

```sh
python3 deploy/clickhouse/test_step2.py
python3 deploy/clickhouse/test_native.py
```

The first suite resolves the real Compose file and tests backup subprocess
construction, failure/redaction and private-file validation using a fake Docker
transport. The second starts the **actual pinned ClickHouse image** on a unique
internal-only test network, checks Docker's effective memory/ports/mounts, exercises
internal DNS/HTTP, the app's idempotent database-creation statement, native **local
Disk** backup, duplicate-backup failure, restart persistence and actual restore
readback. It imports the runner's real stdin/client transport. It cleans only its
unique test project/volumes, never unrelated containers or production volumes.
The test's database creation is an isolated fixture, not a manual production step.
**Local Disk qualification is not DigitalOcean Spaces/S3 acceptance.** Real Spaces
credentials, TLS/permissions, native S3 completion, production cron and live app
bootstrap must still be verified on the approved host.
