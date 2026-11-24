# Manual app-only deployment

GitHub Actions: **Deploy Dittofeed**, `.github/workflows/deploy.yaml`.
Select **Run workflow** on `main`; optional `revision` is a fork ref or full SHA
(default `main`). This is a real production deployment button, not a dry run.
Pushes and releases do not trigger this workflow. No environment approval gate is
configured. One concurrency group serializes app deployments without cancellation.

The runner tests these scripts, builds **only** `packages/lite/Dockerfile` for
linux/amd64 with `APP_VERSION=<resolved SHA>`, labels its source SHA, pushes
`ghcr.io/roninpublishing/dittofeed-lite:sha-<SHA>`, and deploys the returned immutable
**digest**, never a moving tag. SHA tags are discovery aliases; the digest is the
authoritative immutable image identity. Existing upstream publishing is untouched.

## Access and preserved state

Repository Actions secrets:

- `DITTOFEED_DEPLOY_SSH_KEY`: dedicated Ed25519 identity, not an operator/master key.
- `DITTOFEED_DEPLOY_KNOWN_HOSTS`: existing verified host pin, not `ssh-keyscan` output.

The SSH host is Reserved IP `129.212.198.152`, with strict host alias
`159.203.185.52`. Its root-owned `/usr/local/libexec/dittofeed-deploy.py` endpoint
is enforced by a `restrict,command=...` authorized_keys entry: no arbitrary shell,
PTY, agent, X11 or port forwarding. It ignores the requested SSH command. Root
is needed for Docker, but this key does not provide a general root login. The
installed helper is administrator-managed; editing its repository copy does not
silently replace the protected host copy.

Registry access does **not** assume a public package. The same job-scoped
`GITHUB_TOKEN` (`packages: write`, `contents: read`) that publishes the package is
sent via encrypted SSH stdin for `docker login --password-stdin` and digest pull.
The host uses a temporary `DOCKER_CONFIG`, deleted after pull. No permanent
registry credential is installed. A new package must allow repository Actions
access (normally inherited from the source repository label on initial Actions
publication); if organization policy denies creation/access, the build/pull fails
before app activation. Do not weaken visibility to work around a denied token.

The endpoint copies the actually active app-only Compose contract, changing only
`services.lite.image`; it preserves `/etc/dittofeed/runtime.env`, CA read-only
mount, ports, 2 GiB/2 CPU limits and the external network. It requires both
`BOOTSTRAP=false` and `BOOTSTRAP_EVENTS=false`. It only executes:

```
docker compose -p dittofeed-production -f <release-file> up -d --no-deps lite
```

No ClickHouse recreation, Neon/Temporal configuration changes, teardown, prune,
volume deletion, explicit migration, bootstrap or email test is included. A failed
activation or `/api/` version check restores the **previous running image ID**
and Compose contract, then checks its previous revision. Rollback failure is
reported distinctly, requiring an operator. Releases/rollback images are retained.
An in-host lock also prevents concurrent endpoint invocations.

## Migration and health boundaries

At the setup baseline `3fd5450f6b31874d6cf3667a270c814429740529`, traced startup is
`packages/lite/scripts/startLite.ts` -> API `buildApp` / `registerApp` and worker
`buildWorker`. Neither builder calls migration/bootstrap dependencies. Lite calls
`startBootstrapWorkflow` only inside the bootstrap condition. PostgreSQL
`drizzleMigrate` is called by `bootstrapDependencies` (and test global setup), not
unconditionally by those startup builders. With the preserved bootstrap flags,
this pathway does not request a schema migration. This is not a promise for an
arbitrary future selected revision. Confirm schema compatibility separately
before choosing a revision; this workflow does not apply migrations or make an
incompatible schema reversible. Running the app resumes worker activity only if
the preserved runtime enables workers. This rollout keeps `ENABLE_WORKER=false`;
no send/test-send operation or worker re-enablement is part of the pipeline.

Health acceptance is the loopback `/api/` response carrying the exact new
`APP_VERSION`, after Lite startup. With workers disabled, a healthy response does
not prove a running worker. It is **not** an authenticated UI, protected-API,
email-delivery, or complete Temporal workflow acceptance test.
An app restart can briefly interrupt service; no zero-downtime guarantee is made.

## Focused tests

```
python3 -m unittest discover -s scripts/deploy -p 'test_*.py' -v
actionlint .github/workflows/deploy.yaml
```

Fixtures are hermetic: success, failed activation, failed health/rollback,
registry failure, exact-revision health, same-SHA repeat releases, input validation,
pinned SSH and preservation of the prior contract/runtime/data.

The first live manual workflow succeeded in run `45500318016`, deploying full
revision `3b8a361a51269139fb279ad0d073edb326f02014` through build, registry publish,
restricted SSH activation and exact-revision health acceptance. Production Google
owner sign-in and preserved-contact UI acceptance were verified separately.
Workers stayed disabled; PostgreSQL backup and seven additive migrations were
performed separately before deployment. See `FORK_PLAN.md` for the release record,
active logging contract and remaining explicitly gated operations.
