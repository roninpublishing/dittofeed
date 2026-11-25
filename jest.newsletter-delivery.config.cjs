// Run only against an already-migrated, disposable local PostgreSQL database:
// NEWSLETTER_DELIVERY_DATABASE_URL=postgresql://.../newsletter_delivery_proof_<id> \
//   yarn jest --config jest.newsletter-delivery.config.cjs --runInBand
// This harness never runs the repository's destructive global setup/teardown,
// applies migrations, starts workers, or contacts an ESP.
const rawUrl = process.env.NEWSLETTER_DELIVERY_DATABASE_URL;
if (!rawUrl) throw new Error("NEWSLETTER_DELIVERY_DATABASE_URL is required");
const url = new URL(rawUrl);
if (
  !["postgres:", "postgresql:"].includes(url.protocol) ||
  !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
  !/^newsletter_delivery_proof_[a-z0-9_]+$/.test(decodeURIComponent(url.pathname.slice(1)))
) {
  throw new Error("Delivery proof requires a disposable local newsletter_delivery_proof_<id> database");
}
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = url.toString();
process.env.SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
// Never inherit an analytics endpoint or worker address from the user's .env.
process.env.CLICKHOUSE_HOST = "127.0.0.1";
process.env.CLICKHOUSE_DATABASE = "newsletter_delivery_proof_unused";
process.env.CLICKHOUSE_USER = "proof";
process.env.CLICKHOUSE_PASSWORD = "proof";
process.env.TEMPORAL_ADDRESS = "127.0.0.1:1";
process.env.ENABLE_OPEN_TRACKING = "false";
process.env.CLOUDFLARE_TRACKING_ALLOW_PROVISIONING = "false";

const base = {
  rootDir: __dirname,
  testEnvironment: "node",
  clearMocks: true,
  testTimeout: 30000,
  setupFilesAfterEnv: ["<rootDir>/packages/backend-lib/test/setup.ts"],
  moduleNameMapper: {
    "^backend-lib/(.*)$": "<rootDir>/packages/backend-lib/$1",
    "^isomorphic-lib/(.*)$": "<rootDir>/packages/isomorphic-lib/$1",
  },
  modulePathIgnorePatterns: [
    "<rootDir>/.tmp/",
    "<rootDir>/packages/.*/dist/",
  ],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", {
      tsconfig: "<rootDir>/packages/backend-lib/tsconfig.json",
    }],
  },
};

module.exports = {
  maxWorkers: 1,
  projects: [
    {
      ...base,
      displayName: "esp-backend-proof",
      testMatch: [
        "<rootDir>/packages/backend-lib/src/newsletterDelivery.test.ts",
        "<rootDir>/packages/backend-lib/src/newsletterInfrastructure.test.ts",
        "<rootDir>/packages/backend-lib/src/newsletterSendgrid.test.ts",
        "<rootDir>/packages/backend-lib/src/newsletterSendConsumers.test.ts",
        "<rootDir>/packages/backend-lib/src/newsletterAccountReporting.test.ts",
        "<rootDir>/packages/backend-lib/src/broadcasts/lifecycleSelection.test.ts",
        "<rootDir>/packages/backend-lib/src/journeys/selection.test.ts",
        "<rootDir>/packages/backend-lib/src/accountAuthorization.test.ts",
      ],
    },
    {
      ...base,
      displayName: "esp-api-proof",
      testMatch: [
        "<rootDir>/packages/api/src/controllers/publicationsController.test.ts",
        "<rootDir>/packages/api/src/controllers/contentController.test.ts",
      ],
      transform: {
        "^.+\\.tsx?$": ["ts-jest", {
          tsconfig: "<rootDir>/packages/api/tsconfig.json",
        }],
      },
    },
    {
      ...base,
      displayName: "esp-navigation-proof",
      testMatch: [
        "<rootDir>/packages/dashboard/src/lib/navigation.test.ts",
        "<rootDir>/packages/dashboard/src/lib/workspaceRoutes.test.ts",
        "<rootDir>/packages/dashboard/src/lib/workspaceTopology.test.ts",
        "<rootDir>/packages/dashboard/src/components/journeys/store.test.ts",
      ],
      transform: {
        "^.+\\.tsx?$": ["ts-jest", {
          tsconfig: "<rootDir>/packages/dashboard/tsconfig.json",
        }],
      },
    },
  ],
};
