// Pure rules: TRACKING_UNIT_ONLY=true node .yarn/releases/yarn-4.1.1.cjs jest --config jest.tracking.config.cjs --runInBand
// Integration: NODE_ENV=test DATABASE_URL=postgresql://...@127.0.0.1:15432/tracking_proof_<id>
// CLICKHOUSE_HOST=http://127.0.0.1:18123 CLICKHOUSE_DATABASE=tracking_proof_<id>
// node .yarn/releases/yarn-4.1.1.cjs jest --config jest.tracking.config.cjs --runInBand <test-file>
// Global teardown DROPS both databases. Never inherit a preview/production name.
const unitOnly = process.env.TRACKING_UNIT_ONLY === "true";
if (!unitOnly) {
  const databaseUrl = new URL(process.env.DATABASE_URL || "invalid:");
  const analyticsUrl = new URL(process.env.CLICKHOUSE_HOST || "invalid:");
  if (
    process.env.NODE_ENV !== "test" ||
    !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname) ||
    !/^tracking_proof_[a-z0-9_]+$/.test(databaseUrl.pathname.slice(1)) ||
    !["http:", "https:"].includes(analyticsUrl.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(analyticsUrl.hostname) ||
    !/^tracking_proof_[a-z0-9_]+$/.test(process.env.CLICKHOUSE_DATABASE || "")
  ) {
    throw new Error("Tracking integration requires disposable local tracking_proof_<id> databases and NODE_ENV=test");
  }
  process.env.ENABLE_BLOB_STORAGE = "false";
  process.env.BOOTSTRAP_WORKER = "false";
  process.env.CLOUDFLARE_TRACKING_ALLOW_PROVISIONING = "false";
  process.env.ENABLE_OPEN_TRACKING = "false";
}

module.exports = {
  testEnvironment: "node",
  clearMocks: true,
  maxWorkers: 1,
  testTimeout: 30000,
  moduleNameMapper: {
    "^backend-lib/(.*)$": "<rootDir>/packages/backend-lib/$1",
    "^isomorphic-lib/(.*)$": "<rootDir>/packages/isomorphic-lib/$1",
  },
  modulePathIgnorePatterns: ["<rootDir>/.tmp/", "<rootDir>/packages/.*/dist/"],
  testMatch: unitOnly
    ? ["<rootDir>/packages/isomorphic-lib/src/tracking/**/*.test.ts"]
    : [
        "<rootDir>/packages/backend-lib/src/messaging/openTracking*.test.ts",
        "<rootDir>/packages/api/src/controllers/openTrackingController.test.ts",
      ],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", {
      tsconfig: "<rootDir>/packages/backend-lib/tsconfig.json",
    }],
  },
  setupFilesAfterEnv: unitOnly
    ? ["jest-expect-message"]
    : ["<rootDir>/packages/backend-lib/test/setup.ts", "jest-expect-message"],
  ...(unitOnly ? {} : {
    globalSetup: "<rootDir>/packages/backend-lib/test/globalSetup.ts",
    globalTeardown: "<rootDir>/packages/backend-lib/test/globalTeardown.ts",
  }),
};
