import { readMigrationFiles } from "drizzle-orm/migrator";
import { PgDialect } from "drizzle-orm/pg-core";
import { NodePgSession } from "drizzle-orm/node-postgres";
import fs from "fs/promises";
import path from "path";
import { Client } from "pg";
import { PostgresError } from "pg-error-enum";

import config, { databaseUrlWithoutName } from "./config";
import { pool } from "./db";
import logger from "./logger";

async function checkDirectory(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function createDatabase() {
  const client = new Client(databaseUrlWithoutName());
  const { database } = config();
  try {
    await client.connect();
    await client.query(`
      CREATE DATABASE ${database}
    `);
  } catch (e) {
    const error = e as Error;
    if (
      "code" in error &&
      typeof error.code === "string" &&
      // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
      error.code === PostgresError.DUPLICATE_DATABASE
    ) {
      logger().info({ database }, "Database already exists");
    } else {
      throw error;
    }
  } finally {
    await client.end();
  }
}

export async function findDrizzleFolder(dirname: string): Promise<string> {
  // Tries both paths for prod and dev.
  let migrationsFolder = path.join(dirname, "..", "drizzle");
  if (!(await checkDirectory(migrationsFolder))) {
    logger().info(
      { migrationsFolder },
      "Migrations folder not found, trying root package dir",
    );
    // Have to go up two levels to get to the drizzle folder because we're inside of the dist folder.
    migrationsFolder = path.join(dirname, "..", "..", "drizzle");
    if (!(await checkDirectory(migrationsFolder))) {
      logger().error(
        { migrationsFolder },
        "Migrations folder not found, aborting",
      );
      throw new Error("Migrations folder not found");
    }
  }
  return migrationsFolder;
}

export async function publicDrizzleMigrate() {
  const migrationsFolder = await findDrizzleFolder(__dirname);

  logger().info({ migrationsFolder }, "Running migrations");
  const migrations = readMigrationFiles({ migrationsFolder });
  for (const migration of migrations) {
    const first = migration.sql[0];
    const lastIndex = migration.sql.length - 1;
    const last = migration.sql[lastIndex];
    // Historical 0002 owns BEGIN/COMMIT. Preserve its recorded hash while keeping
    // execution inside Drizzle's transaction, including later registry migrations.
    if (first && last && /^\s*BEGIN;/.test(first) && /COMMIT;\s*$/.test(last)) {
      migration.sql[0] = first.replace(/^\s*BEGIN;\s*/, "");
      migration.sql[lastIndex] = migration.sql[lastIndex]!.replace(/\s*COMMIT;\s*$/, "");
    }
  }
  const dialect = new PgDialect();
  const session = new NodePgSession<Record<string, never>, Record<string, never>>(pool(), dialect, undefined);
  await dialect.migrate(migrations, session, { migrationsFolder });
}

export async function drizzleMigrate() {
  await createDatabase();
  await publicDrizzleMigrate();
}
