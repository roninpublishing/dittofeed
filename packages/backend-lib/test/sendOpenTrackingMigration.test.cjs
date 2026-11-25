const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { Client } = require("pg");

// Explicit disposable-database opt-in; every fixture and DDL change rolls back.
// Fresh historical migration coverage lives in freshMigrations.test.cjs.
test("canonical open tracking cutover refuses every nonempty legacy table and preserves unrelated data", async () => {
  const connectionString = process.env.TEST_MIGRATION_DATABASE_URL;
  assert.ok(connectionString, "Set TEST_MIGRATION_DATABASE_URL explicitly to a disposable PostgreSQL database; DATABASE_URL is deliberately ignored");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    const schema = `send_open_tracking_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query('CREATE TABLE "NewsletterSend" ("id" integer PRIMARY KEY, "payload" text NOT NULL)');
    await client.query('INSERT INTO "NewsletterSend" VALUES (1, \'preserved send\'), (2, \'another send\'), (3, \'third send\')');
    await client.query('CREATE TABLE "ContactHistory" ("evidence" text NOT NULL)');
    await client.query('INSERT INTO "ContactHistory" VALUES (\'preserved contact history\')');
    const legacyTables = ["EmailOpenTrackingReceipt", "EmailOpenTrackingSend", "EmailOpenTrackingTombstone"];
    for (const table of legacyTables) {
      await client.query(`CREATE TABLE "${table}" ("evidence" text NOT NULL)`);
    }
    const migration = await readFile(path.join(__dirname, "../drizzle/0019_send_open_tracking.sql"), "utf8");
    for (const table of legacyTables) {
      await client.query(`INSERT INTO "${table}" VALUES ('must survive')`);
      await client.query("SAVEPOINT guarded_cutover");
      await assert.rejects(client.query(migration), /requires empty legacy tracking tables/);
      await client.query("ROLLBACK TO SAVEPOINT guarded_cutover");
      await client.query("RELEASE SAVEPOINT guarded_cutover");
      assert.deepEqual((await client.query(`SELECT * FROM "${table}"`)).rows, [{ evidence: "must survive" }]);
      for (const existing of legacyTables) {
        assert.ok((await client.query("SELECT to_regclass($1) AS name", [`"${existing}"`])).rows[0].name);
      }
      await client.query(`DELETE FROM "${table}"`);
    }
    await client.query(migration);
    const columns = (await client.query("SELECT column_name, is_nullable, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'NewsletterSend'")).rows;
    for (const [name, type] of [["openTrackingTokenHash", "text"], ["encryptedOpenTrackingToken", "jsonb"], ["openTrackingOrigin", "text"]]) {
      assert.deepEqual(columns.find((column) => column.column_name === name), { column_name: name, is_nullable: "YES", data_type: type });
    }
    const index = (await client.query("SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'NewsletterSend_openTrackingTokenHash_unique'")).rows[0];
    assert.match(index.indexdef, /CREATE UNIQUE INDEX/);
    assert.match(index.indexdef, /WHERE \("openTrackingTokenHash" IS NOT NULL\)/);
    await client.query('UPDATE "NewsletterSend" SET "openTrackingTokenHash" = \'unique-token\' WHERE "id" = 1');
    await client.query("SAVEPOINT duplicate_token");
    await assert.rejects(client.query('UPDATE "NewsletterSend" SET "openTrackingTokenHash" = \'unique-token\' WHERE "id" = 2'), (error) => error.code === "23505");
    await client.query("ROLLBACK TO SAVEPOINT duplicate_token");
    await client.query("RELEASE SAVEPOINT duplicate_token");
    assert.deepEqual((await client.query('SELECT "id", "payload" FROM "NewsletterSend" ORDER BY "id"')).rows, [
      { id: 1, payload: "preserved send" }, { id: 2, payload: "another send" }, { id: 3, payload: "third send" },
    ]);
    assert.deepEqual((await client.query('SELECT * FROM "ContactHistory"')).rows, [{ evidence: "preserved contact history" }]);
    for (const table of legacyTables) {
      assert.equal((await client.query("SELECT to_regclass($1) AS name", [`"${table}"`])).rows[0].name, null);
    }
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
