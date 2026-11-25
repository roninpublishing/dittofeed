const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { Client } = require("pg");

// Run explicitly with node --test, never Jest's destructive database lifecycle.
// All historical DDL, fixtures and the cutover stay in one rolled-back schema.
const migrationDirectory = path.join(__dirname, "../drizzle");
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ciphertext = (label) => ({ iv: label, encryptedData: `${label}-ciphertext`, authTag: `${label}-tag` });

async function rows(client, table, order = '"id"') {
  return (await client.query(`SELECT * FROM "${table}" ORDER BY ${order}`)).rows;
}

async function expectConstraint(client, sql, values = [], code = "23514") {
  await client.query("SAVEPOINT expected_constraint");
  try {
    await assert.rejects(client.query(sql, values), (error) => error.code === code);
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT expected_constraint");
    await client.query("RELEASE SAVEPOINT expected_constraint");
  }
}

async function seed(client) {
  for (const n of [1, 2, 3, 4, 5, 101, 102, 103, 104]) {
    await client.query('INSERT INTO "Workspace" ("id", "name", "updatedAt") VALUES ($1, $2, $3)', [id(n), `workspace-${n}`, "2025-01-01T00:00:00Z"]);
  }
  for (const n of [1, 2, 3, 4, 5]) {
    await client.query('INSERT INTO "Publisher" ("workspaceId") VALUES ($1)', [id(n)]);
  }
  for (const [n, publisher] of [[101, 1], [102, 1], [103, 2], [104, 4]]) {
    await client.query('INSERT INTO "Newsletter" ("workspaceId", "publisherId", "slug") VALUES ($1, $2, $3)', [id(n), id(publisher), `newsletter-${n}`]);
  }
  for (const n of [1, 2, 3]) {
    await client.query(`INSERT INTO "PublisherSendgridAccount" (
      "publisherId", "encryptedManagementKey", "region", "callbackBaseUrl", "allowProviderWrites",
      "allowIpReassignment", "allowRealSends", "allTrafficControlled", "updatedAt"
    ) VALUES ($1, $2, $3, $4, true, true, true, true, $5)`, [
      id(n), ciphertext(`management-${n}`), n === 2 ? "eu" : "global",
      `https://callbacks-${n}.example.test`, "2025-02-01T00:00:00Z",
    ]);
  }
  for (const [n, publisher, newsletter] of [[201, 1, 101], [202, 1, 102], [203, 2, 103]]) {
    await client.query(`INSERT INTO "SendingConnection" (
      "id", "publisherId", "newsletterId", "username", "administrativeEmail", "encryptedApiKey",
      "apiKeyId", "revision", "senderDomains", "senderEmails", "webhookKeys", "status", "provisioning", "createdAt", "updatedAt"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'ready', $12, $13, $13)`, [
      id(n), id(publisher), id(newsletter), `existing-subuser-${n}`, `admin-${n}@example.test`,
      ciphertext(`sending-${n}`), `provider-key-${n}`, n - 194,
      JSON.stringify([`sender-${n}.example.test`]), JSON.stringify([`sender-${n}@example.test`]),
      JSON.stringify([{ key: `verification-${n}`, validUntil: "2030-01-01T00:00:00Z" }]),
      { inspectedAt: "2025-01-01T00:00:00Z", providerIdentity: `subuser-${n}` }, "2025-01-01T00:00:00Z",
    ]);
  }
  for (const [n, publisher, name] of [[301, 1, "shared-pool"], [302, 2, "other-pool"], [303, 5, "unbound-pool"]]) {
    await client.query('INSERT INTO "SendingPool" ("id", "publisherId", "name") VALUES ($1, $2, $3)', [id(n), id(publisher), name]);
  }
  for (const [n, publisher, address, limit] of [
    [401, 1, "2001:0db8:0000:0000:0000:0000:0000:0001", 100],
    [402, 2, "2001:db8::1", 50],
    [403, 1, "192.0.2.23", 200],
    [404, 5, "198.51.100.7", 80],
  ]) {
    await client.query(`INSERT INTO "SendingIp" (
      "id", "publisherId", "address", "status", "hourlyLimit", "dailyLimit", "warmupStartedAt", "warmupSchedule"
    ) VALUES ($1, $2, $3, 'active', $4, $5, $6, $7)`, [
      id(n), id(publisher), address, limit, limit * 10, "2025-01-01T00:00:00Z",
      JSON.stringify([{ afterDays: 0, hourlyLimit: limit, dailyLimit: limit * 10 }]),
    ]);
  }
  for (const [pool, ip] of [[301, 401], [301, 403], [302, 402], [303, 404]]) {
    await client.query('INSERT INTO "SendingPoolIp" ("poolId", "ipId") VALUES ($1, $2)', [id(pool), id(ip)]);
  }
  for (const [n, connection, pool, providerName] of [[501, 201, 301, "provider-a"], [502, 202, 301, "provider-b"], [503, 203, 302, "provider-c"]]) {
    await client.query('INSERT INTO "SendingPoolBinding" ("id", "connectionId", "poolId", "providerPoolName") VALUES ($1, $2, $3, $4)', [id(n), id(connection), id(pool), providerName]);
  }
  for (const [newsletter, connection] of [[101, 201], [102, 202]]) {
    await client.query('INSERT INTO "NewsletterRoute" ("newsletterId", "connectionId", "poolId", "version") VALUES ($1, $2, $3, 17)', [id(newsletter), id(connection), id(301)]);
  }
  for (const [n, publisher, newsletter, connection, ip, pool, state] of [
    [601, 1, 101, 201, 401, 301, "accepted"],
    [602, 1, 102, 202, 403, 301, "unknown"],
    [603, 2, 103, 203, 402, 302, "queued"],
    // A reserved legacy retry whose pool now has another member must retain only its original IP.
    [604, 1, 101, 201, 401, 301, "queued"],
  ]) {
    await client.query(`INSERT INTO "NewsletterSend" (
      "id", "publisherId", "workspaceId", "connectionId", "connectionRevision", "ipId", "poolId", "routeVersion",
      "logicalMessageId", "userId", "mailboxHash", "encryptedRecipient", "encryptedPayload", "encryptedCredential", "payloadHash",
      "state", "providerMessageId", "providerSmtpId", "attempts", "recipientCount", "reservedAt", "createdAt", "updatedAt", "nextAttemptAt"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 17, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 1, 2, $18, $18, $18, $18)`, [
      id(n), id(publisher), id(newsletter), id(connection), connection - 194, id(ip), id(pool),
      `logical-${n}`, `user-${n}`, `mailbox-${n}`, ciphertext(`recipients-${n}`),
      ciphertext(`rendered-pool-${n}`), ciphertext(`pinned-credential-${n}`), `payload-hash-${n}`, state,
      state === "accepted" ? `provider-message-${n}` : null, `provider-smtp-${n}`, "2025-03-01T00:00:00Z",
    ]);
    await client.query(`INSERT INTO "NewsletterWebhookReceipt" ("id", "connectionId", "sendId", "eventId", "mailboxHash", "encryptedPayload", "attempts")
      VALUES ($1, $2, $3, $4, $5, $6, 3)`, [id(n + 100), id(connection), id(n), `event-${n}`, `mailbox-${n}`, ciphertext(`receipt-${n}`)]);
  }
  for (const [ip, seconds, reserved] of [[401, 3600, 11], [402, 3600, 13], [401, 86400, 30], [402, 86400, 20], [403, 3600, 9]]) {
    await client.query('INSERT INTO "SendingIpBudget" ("ipId", "windowStart", "windowSeconds", "reserved") VALUES ($1, $2, $3, $4)', [id(ip), "2025-03-01T00:00:00Z", seconds, reserved]);
  }
}

test("ESP account cutover preserves immutable attempts and shares physical budgets across accounts and publishers", async () => {
  const connectionString = process.env.TEST_MIGRATION_DATABASE_URL;
  assert.ok(connectionString, "Set TEST_MIGRATION_DATABASE_URL explicitly to a disposable PostgreSQL database; DATABASE_URL is deliberately ignored");
  const schema = `esp_migration_${randomUUID().replaceAll("-", "")}`;
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    const journal = JSON.parse(await readFile(path.join(migrationDirectory, "meta/_journal.json"), "utf8"));
    for (const entry of journal.entries.filter((entry) => entry.idx < 18)) {
      const sql = await readFile(path.join(migrationDirectory, `${entry.tag}.sql`), "utf8");
      // Historical 0002 wraps itself in BEGIN/COMMIT. Strip only standalone
      // wrappers so this proof's outer transaction and LOCAL schema cannot escape.
      const scoped = sql.replace(/^\s*(?:BEGIN|COMMIT);\s*$/gm, "").replaceAll('"public".', `"${schema}".`);
      await client.query(scoped);
    }
    assert.equal((await client.query("SELECT current_schema() AS schema")).rows[0].schema, schema);
    await seed(client);
    const before = {
      connections: await rows(client, "SendingConnection"),
      sends: await rows(client, "NewsletterSend"),
      receipts: await rows(client, "NewsletterWebhookReceipt"),
      routes: await rows(client, "NewsletterRoute", '"newsletterId"'),
      accounts: await rows(client, "PublisherSendgridAccount", '"publisherId"'),
      budgets: await rows(client, "SendingIpBudget", '"ipId", "windowSeconds"'),
    };
    const cutover = await readFile(path.join(migrationDirectory, "0018_esp_accounts.sql"), "utf8");
    await client.query("SAVEPOINT invalid_legacy_ownership");
    await client.query('UPDATE "SendingPoolBinding" SET "poolId" = $1 WHERE "id" = $2', [id(302), id(501)]);
    await assert.rejects(client.query(cutover), (error) => error.code === "23514");
    await client.query("ROLLBACK TO SAVEPOINT invalid_legacy_ownership");
    await client.query("RELEASE SAVEPOINT invalid_legacy_ownership");
    await client.query(cutover);

    const connections = await rows(client, "SendingConnection");
    for (const original of before.connections) {
      const { accountId, ...preserved } = connections.find((row) => row.id === original.id);
      assert.deepEqual(preserved, original, "Original subuser credentials, signing keys and IDs must remain byte-for-byte equivalent");
      assert.equal(accountId, original.id);
    }
    const accounts = await rows(client, "PublisherSendgridAccount");
    assert.equal(accounts.filter((row) => row.publisherId === id(1)).length, 2);
    assert.equal(accounts.filter((row) => row.publisherId === id(4)).length, 0, "A newsletter without infrastructure must not gain an ESP account");
    for (const account of accounts) {
      const original = before.accounts.find((row) => row.publisherId === account.publisherId);
      if (original) {
        for (const field of Object.keys(original)) assert.deepEqual(account[field], original[field]);
      } else {
        assert.equal(account.publisherId, id(5), "Orphan legacy resources receive a local account without invented credentials");
        assert.equal(account.encryptedManagementKey, null);
        assert.equal(account.allowProviderWrites, false);
        assert.equal(account.allowRealSends, false);
      }
      assert.equal(account.provider, "SendGrid");
      assert.equal(account.revision, 1);
      assert.equal(connections.filter((row) => row.accountId === account.id).length, 1);
    }
    const parentConnection = connections.find((row) => row.publisherId === id(3));
    assert.equal(parentConnection.username, "");
    assert.equal(parentConnection.newsletterId, null);
    assert.equal(parentConnection.encryptedApiKey, null);
    assert.equal(parentConnection.status, "draft");
    await expectConstraint(client, 'INSERT INTO "SendingConnection" ("publisherId", "accountId", "username", "administrativeEmail") VALUES ($1, $2, $3, $4)', [id(1), id(201), "duplicate-current-resource", ""], "23505");

    const ips = await rows(client, "SendingIp");
    assert.ok(ips.every((ip) => ip.providerVerifiedAt === null && ip.verifiedAccountRevision === null), "Migration must not invent provider verification for legacy registrations or account-local copies");
    const pools = await rows(client, "SendingPool");
    const bindings = await rows(client, "SendingPoolBinding");
    const memberships = await rows(client, "SendingPoolIp", '"poolId", "ipId"');
    for (const originalId of [401, 402, 403, 404]) assert.ok(ips.some((row) => row.id === id(originalId)));
    for (const originalId of [301, 302, 303]) assert.ok(pools.some((row) => row.id === id(originalId)));
    assert.equal(pools.length, 4);
    for (const [bindingId, connectionId, providerName] of [[501, 201, "provider-a"], [502, 202, "provider-b"], [503, 203, "provider-c"]]) {
      const binding = bindings.find((row) => row.id === id(bindingId));
      const pool = pools.find((row) => row.id === binding.poolId);
      assert.equal(binding.connectionId, id(connectionId));
      assert.equal(pool.accountId, id(connectionId));
      assert.equal(pool.providerPoolName, providerName);
      assert.equal(binding.providerPoolName, providerName);
    }
    for (const membership of memberships) {
      assert.equal(pools.find((row) => row.id === membership.poolId).accountId, ips.find((row) => row.id === membership.ipId).accountId);
    }
    const physical = ips.filter((row) => row.address.includes(":"));
    assert.ok(new Set(physical.map((row) => row.publisherId)).size > 1);
    assert.deepEqual([...new Set(physical.map((row) => row.canonicalIpId))], [id(401)]);
    assert.equal(ips.find((row) => row.id === id(401)).canonicalIpId, id(401));
    const budgets = await rows(client, "SendingIpBudget", '"ipId", "windowSeconds"');
    assert.equal(budgets.reduce((sum, row) => sum + row.reserved, 0), before.budgets.reduce((sum, row) => sum + row.reserved, 0));
    assert.equal(budgets.find((row) => row.ipId === id(401) && row.windowSeconds === 3600).reserved, 24);
    assert.equal(budgets.find((row) => row.ipId === id(401) && row.windowSeconds === 86400).reserved, 50);
    assert.ok(budgets.every((row) => ips.find((ip) => ip.id === row.ipId).canonicalIpId === row.ipId));

    const sends = await rows(client, "NewsletterSend");
    for (const original of before.sends) {
      const { accountId, accountRevision, selection, candidateIpIds, actualIp, ...preserved } = sends.find((row) => row.id === original.id);
      assert.deepEqual(preserved, original, "Accepted/unknown/queued history, ciphertext, credentials and retry identity cannot change");
      assert.equal(accountId, original.connectionId);
      assert.equal(accountRevision, 1);
      assert.equal(actualIp, null, "A selected/reserved IP is not a provider-reported actual IP");
      assert.equal(selection.accountId, accountId);
      assert.equal(selection.mode, "pool");
      assert.equal(pools.find((pool) => pool.id === selection.poolId).accountId, accountId);
      assert.equal(candidateIpIds.length, 1, "Migration cannot broaden a reserved legacy attempt to current pool membership");
      const mappedOriginalIp = ips.find((ip) => ip.accountId === accountId && ip.address === ips.find((row) => row.id === original.ipId).address);
      assert.deepEqual(candidateIpIds, [mappedOriginalIp.id]);
      if (original.id === id(604)) {
        assert.equal(memberships.filter((row) => row.poolId === selection.poolId).length, 2, "Fixture must contain a drifted, broadened pool");
        assert.equal(preserved.state, "queued");
        assert.equal(preserved.attempts, original.attempts, "Cutover cannot authorize a new submission");
        assert.deepEqual(preserved.reservedAt, original.reservedAt, "Existing physical reservation must remain unchanged");
      }
    }
    assert.deepEqual(await rows(client, "NewsletterWebhookReceipt"), before.receipts);
    assert.deepEqual(await rows(client, "NewsletterRoute", '"newsletterId"'), before.routes);
    const defaults = await rows(client, "NewsletterDefault", '"newsletterId"');
    assert.equal(defaults.length, 2);
    for (const preference of defaults) {
      const route = before.routes.find((row) => row.newsletterId === preference.newsletterId);
      assert.equal(preference.selection.accountId, route.connectionId);
      assert.equal(preference.selection.poolId, bindings.find((row) => row.connectionId === route.connectionId).poolId);
      assert.deepEqual(preference.updatedAt, route.updatedAt);
    }
    await client.query('UPDATE "NewsletterDefault" SET "selection" = NULL WHERE "newsletterId" = $1', [id(101)]);
    assert.deepEqual(await rows(client, "NewsletterSend"), sends, "Changing optional defaults cannot retarget historical/queued attempts");
    assert.ok((await client.query('SELECT to_regclass($1) AS table_name', [`"${schema}"."SmsProvider"`])).rows[0].table_name);
    assert.ok((await client.query('SELECT unnest(enum_range(NULL::"DBChannelType"))::text AS channel')).rows.some((row) => row.channel === "Sms"));

    const addedAccount = id(801);
    await client.query('INSERT INTO "PublisherSendgridAccount" ("id", "publisherId", "name") VALUES ($1, $2, $3)', [addedAccount, id(1), "Another SendGrid"]);
    const addedIp = (await client.query(`INSERT INTO "SendingIp" (
      "publisherId", "accountId", "canonicalIpId", "address", "hourlyLimit", "dailyLimit"
    ) VALUES ($1, $2, $3, $4, 25, 250) RETURNING *`, [id(1), addedAccount, id(403), "2001:db8:0:0:0:0:0:1"])).rows[0];
    assert.equal(addedIp.canonicalIpId, id(401), "A caller-supplied root cannot manufacture physical capacity");
    assert.equal(addedIp.providerVerifiedAt, null, "Registering a draft alias cannot invent provider-verified ownership");
    assert.equal(addedIp.verifiedAccountRevision, null);
    const mappedV4 = (await client.query(`INSERT INTO "SendingIp" (
      "publisherId", "accountId", "address", "hourlyLimit", "dailyLimit"
    ) VALUES ($1, $2, $3, 25, 250) RETURNING *`, [id(1), addedAccount, "::ffff:192.0.2.23"])).rows[0];
    assert.equal(mappedV4.canonicalIpId, id(403), "IPv4-mapped IPv6 spellings share the same physical IPv4 budget");
    assert.equal(mappedV4.providerVerifiedAt, null);
    assert.equal(mappedV4.verifiedAccountRevision, null);
    await expectConstraint(client, 'INSERT INTO "SendingIpBudget" ("ipId", "windowStart", "windowSeconds", "reserved") VALUES ($1, now(), 3600, 1)', [addedIp.id]);
    await expectConstraint(client, 'INSERT INTO "SendingConnection" ("publisherId", "accountId", "username", "administrativeEmail") VALUES ($1, $2, $3, $4)', [id(2), addedAccount, "wrong-owner", ""]);
    await expectConstraint(client, 'INSERT INTO "SendingPoolIp" ("poolId", "ipId") VALUES ($1, $2)', [pools.find((row) => row.accountId === id(201)).id, addedIp.id]);
    await expectConstraint(client, 'UPDATE "SendingIp" SET "canonicalIpId" = $1 WHERE "id" = $2', [id(403), addedIp.id]);
    await expectConstraint(client, 'UPDATE "NewsletterSend" SET "selection" = $1 WHERE "id" = $2', [{ accountId: addedAccount, mode: "automatic" }, id(602)]);
    await expectConstraint(client, `INSERT INTO "NewsletterSend" (
      "publisherId", "accountId", "accountRevision", "workspaceId", "connectionId", "connectionRevision",
      "selection", "candidateIpIds", "logicalMessageId", "userId", "mailboxHash", "payloadHash"
    ) VALUES ($1, $2, 1, $3, $4, 7, $5, $6, 'foreign-candidate', 'user', 'hash', 'payload')`, [
      id(1), id(201), id(101), id(201), { accountId: id(201), mode: "automatic" }, JSON.stringify([addedIp.id]),
    ]);
    await client.query('UPDATE "NewsletterSend" SET "actualIp" = $1 WHERE "id" = $2', ["2001:db8::1", id(601)]);
    assert.equal((await rows(client, "NewsletterSend")).find((row) => row.id === id(601)).actualIp, "2001:db8::1");
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
