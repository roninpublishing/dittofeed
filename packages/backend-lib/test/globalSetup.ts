import { createBucket, storage } from "../src/blobStorage";
import { bootstrapClickhouse } from "../src/bootstrap";
import config from "../src/config";
import { endPool } from "../src/db";
import { drizzleMigrate } from "../src/migrate";

export default async function globalSetup() {
  const tasks = [bootstrapClickhouse(), drizzleMigrate()];
  if (config().enableBlobStorage) {
    const s3 = storage();
    tasks.push(
      (async () => {
        try {
          await createBucket(s3, { bucketName: config().blobStorageBucket });
        } catch (e) {
          const err = e as { name?: string; Code?: string };
          const code = err.name ?? err.Code;
          if (
            code !== "BucketAlreadyOwnedByYou" &&
            code !== "BucketAlreadyExists"
          ) {
            throw e;
          }
        }
      })(),
    );
  }
  await Promise.all(tasks);
  // Drizzle pins transactions via instanceof Pool. A migration-owned Pool
  // copied into Jest's VM belongs to another realm and breaks that check.
  await endPool();
  globalThis.DB = null;
  globalThis.POOL_ENDED = false;
}
