// Pure registration/discovery only. Never inherit the default API project's
// database-creating/dropping globalSetup/globalTeardown or backend test setup.
require("./scripts/mcp-parity.setup.cjs");

module.exports = {
  rootDir: __dirname,
  roots: ["<rootDir>/packages/api/src"],
  displayName: "mcp-route-parity",
  testEnvironment: "node",
  clearMocks: true,
  maxWorkers: 1,
  testTimeout: 120000,
  testMatch: ["<rootDir>/packages/api/src/buildApp/mcpParity.test.ts"],
  setupFiles: ["<rootDir>/scripts/mcp-parity.setup.cjs"],
  setupFilesAfterEnv: ["jest-expect-message"],
  moduleNameMapper: {
    "^backend-lib/(.*)$": "<rootDir>/packages/backend-lib/$1",
    "^isomorphic-lib/(.*)$": "<rootDir>/packages/isomorphic-lib/$1",
  },
  modulePathIgnorePatterns: ["<rootDir>/.tmp/"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", {
      tsconfig: "<rootDir>/packages/api/tsconfig.json",
    }],
  },
};
