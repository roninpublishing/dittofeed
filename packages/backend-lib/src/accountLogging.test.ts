import { spawnSync } from "child_process";
import path from "path";

test("real application logging redacts Google and session secrets at flat and config-object paths", () => {
  const root = path.resolve(__dirname, "../../..");
  const googleSecret = "private-google-fixture-value";
  const cookieSecret = "private-session-fixture-value";
  const result = spawnSync(
    process.execPath,
    [
      "-r",
      "ts-node/register/transpile-only",
      "-e",
      `
    const logger = require('./packages/backend-lib/src/logger').default;
    logger().info({googleClientSecret: ${JSON.stringify(googleSecret)}, secretKey: ${JSON.stringify(cookieSecret)}, config: {googleClientSecret: ${JSON.stringify(googleSecret)}, secretKey: ${JSON.stringify(cookieSecret)}}}, 'Google log privacy fixture');
  `,
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 20000,
      env: {
        ...process.env,
        NODE_ENV: "test",
        TS_NODE_PROJECT: path.join(root, "packages/backend-lib/tsconfig.json"),
        PRETTY_LOGS: "false",
        LOG_LEVEL: "info",
        LOG_CONFIG: "false",
        EXPORT_LOGS_HYPER_DX: "false",
      },
    },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Google log privacy fixture");
  expect(result.stdout).not.toContain(googleSecret);
  expect(result.stdout).not.toContain(cookieSecret);
});

test("the deployed ES5 build preserves account-error identity and HTTP status", () => {
  const root = path.resolve(__dirname, "../../..");
  const result = spawnSync(
    process.execPath,
    [
      "-r",
      "ts-node/register/transpile-only",
      "-e",
      `
        const { AccountError } = require('./packages/backend-lib/src/accounts');
        const error = new AccountError('not_configured', 503);
        process.stdout.write(JSON.stringify({isAccountError: error instanceof AccountError, statusCode: error.statusCode}));
      `,
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 20000,
      env: {
        ...process.env,
        NODE_ENV: "test",
        TS_NODE_PROJECT: path.join(root, "packages/backend-lib/tsconfig.json"),
        TS_NODE_COMPILER_OPTIONS: JSON.stringify({ target: "es5" }),
        LOG_CONFIG: "false",
      },
    },
  );
  expect(result.status).toBe(0);
  const resultData: unknown = JSON.parse(result.stdout);
  expect(resultData).toEqual({ isAccountError: true, statusCode: 503 });
});
