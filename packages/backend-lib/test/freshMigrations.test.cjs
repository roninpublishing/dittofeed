const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { promisify } = require("node:util");
const { Client } = require("pg");

const run = promisify(execFile);

test("fresh bootstrap applies every original migration hash atomically and remains restartable", async () => {
  const connectionString = process.env.NEWSLETTER_DELIVERY_DATABASE_URL;
  assert.ok(connectionString, "Explicit disposable local database required");
  const url = new URL(connectionString);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /^\/newsletter_delivery_proof_[a-z0-9_]+$/);
  const client = new Client({ connectionString });
  await client.connect();
  try {
    assert.equal((await client.query("SELECT to_regclass('public.\"Workspace\"') AS existing")).rows[0].existing, null, "Run this proof against a fresh disposable database");
    const command = "const {publicDrizzleMigrate}=require('./packages/backend-lib/src/migrate'); const {endPool}=require('./packages/backend-lib/src/db'); publicDrizzleMigrate().then(endPool).catch(async e=>{console.error(e.message);await endPool();process.exitCode=1;});";
    const options = { cwd: path.resolve(__dirname, "../../.."), env: { ...process.env, DATABASE_URL: connectionString, LOG_CONFIG: "false", START_OTEL: "false", TS_NODE_PROJECT: "packages/backend-lib/tsconfig.json", TS_NODE_TRANSPILE_ONLY: "true" } };
    await run(process.execPath, ["-r", "ts-node/register", "-e", command], options);
    const directory = path.join(__dirname, "../drizzle");
    const journal = JSON.parse(await readFile(path.join(directory, "meta/_journal.json"), "utf8"));
    const expected = [];
    for (const entry of journal.entries) {
      expected.push({ hash: createHash("sha256").update(await readFile(path.join(directory, `${entry.tag}.sql`))).digest("hex"), created_at: String(entry.when) });
    }
    const history = (await client.query("SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at")).rows;
    assert.deepEqual(history, expected, "Execution normalization must never rewrite historical hashes");
    assert.equal((await client.query("SELECT to_regclass('public.\"NewsletterDefault\"') AS account_defaults")).rows[0].account_defaults, '"NewsletterDefault"');
    await run(process.execPath, ["-r", "ts-node/register", "-e", command], options);
    assert.deepEqual((await client.query("SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at")).rows, history, "Restart must not reapply or duplicate migrations");
  } finally { await client.end(); }
});
