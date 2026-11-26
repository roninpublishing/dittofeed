// Runs before any application import, both from the dedicated Jest config and
// inside its test environment. dotenv never overrides these explicit values.
Object.assign(process.env, {
  NODE_ENV: "test",
  MCP_PARITY_ISOLATED: "true",
  DATABASE_URL: "postgresql://parity:parity@127.0.0.1:1/mcp_parity_never_connect?connect_timeout=1",
  DATABASE_HOST: "127.0.0.1",
  DATABASE_PORT: "1",
  DATABASE_NAME: "mcp_parity_never_connect",
  DATABASE_NAME_SUFFIX: "mcp_parity_never_connect",
  DATABASE_USER: "parity",
  DATABASE_PASSWORD: "parity",
  DATABASE_PARAMS: "connect_timeout=1",
  PGHOST: "127.0.0.1",
  PGPORT: "1",
  PGDATABASE: "mcp_parity_never_connect",
  PGUSER: "parity",
  PGPASSWORD: "parity",
  CLICKHOUSE_HOST: "http://127.0.0.1:1",
  CLICKHOUSE_PROTOCOL: "http",
  CLICKHOUSE_DATABASE: "mcp_parity_never_connect",
  CLICKHOUSE_USER: "parity",
  CLICKHOUSE_PASSWORD: "parity",
  TEMPORAL_ADDRESS: "127.0.0.1:1",
  TEMPORAL_NAMESPACE: "mcp-parity-never-connect",
  TEMPORAL_API_KEY: "",
  KAFKA_BROKERS: "127.0.0.1:1",
  KAFKA_USERNAME: "",
  KAFKA_PASSWORD: "",
  WRITE_MODE: "ch-sync",
  AUTH_MODE: "anonymous",
  SECRET_KEY: "mcp-parity-isolated-secret-not-for-credentials",
  PASSWORD: "parity-unused",
  DASHBOARD_URL: "http://127.0.0.1:1",
  DASHBOARD_API_BASE: "http://127.0.0.1:1",
  DASHBOARD_API_NAME: "",
  DASHBOARD_WRITE_KEY: "",
  LOG_CONFIG: "false",
  LOG_LEVEL: "silent",
  BOOTSTRAP: "false",
  BOOTSTRAP_EVENTS: "false",
  BOOTSTRAP_WORKER: "false",
  BOOTSTRAP_SAFE: "false",
  GOOGLE_OPS: "false",
  GOOGLE_CLIENT_ID: "",
  GOOGLE_CLIENT_SECRET: "",
  GOOGLE_BOOTSTRAP_ADMIN_EMAIL: "",
  GOOGLE_BOOTSTRAP_WORKSPACE_ID: "",
  GOOGLE_BOOTSTRAP_ADMIN_SUBJECT: "",
  GMAIL_CLIENT_ID: "",
  GMAIL_CLIENT_SECRET: "",
  ENABLE_OPEN_TRACKING: "false",
  ENABLE_OPEN_TRACKING_DEV_LAKE: "false",
  OPEN_TRACKING_RELAY_SECRET: "",
  CLOUDFLARE_TRACKING_ALLOW_PROVISIONING: "false",
  CLOUDFLARE_TRACKING_API_TOKEN: "",
  CLOUDFLARE_TRACKING_ZONE_ID: "",
  ENABLE_BLOB_STORAGE: "false",
  ENABLE_COLD_STORAGE: "false",
  BLOB_STORAGE_ENDPOINT: "http://127.0.0.1:1",
  BLOB_STORAGE_INTERNAL_ENDPOINT: "http://127.0.0.1:1",
  BLOB_STORAGE_ACCESS_KEY_ID: "parity-unused",
  BLOB_STORAGE_SECRET_ACCESS_KEY: "parity-unused",
  BLOB_STORAGE_BUCKET: "mcp-parity-unused",
  ENABLE_SOURCE_CONTROL: "false",
  TRACK_DASHBOARD: "false",
  START_OTEL: "false",
  OTEL_SDK_DISABLED: "true",
  OTEL_COLLECTOR: "http://127.0.0.1:1",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1",
  EXPORT_LOGS_HYPER_DX: "false",
  HYPER_DX_API_KEY: "",
});

const attempts = [];
globalThis[Symbol.for("dittofeed.mcpParity.deniedIo")] = attempts;
function deny(facility) {
  return function deniedParityIo() {
    // Never record arguments: they may contain user credentials or request data.
    attempts.push(facility);
    throw new Error(`Pure MCP parity must not perform ${facility}`);
  };
}

// Deny at transports, not application services: genuine router/controller/schema
// registration still runs unchanged. The sentinel endpoints above also protect
// native clients that do not use Node's network transports.
const net = require("node:net");
const tls = require("node:tls");
const http = require("node:http");
const https = require("node:https");
net.Socket.prototype.connect = deny("socket connection");
net.connect = deny("network connection");
net.createConnection = deny("network connection");
tls.connect = deny("TLS connection");
http.request = deny("HTTP request");
http.get = deny("HTTP request");
https.request = deny("HTTPS request");
https.get = deny("HTTPS request");
globalThis.fetch = deny("fetch request");

// Reject even query attempts caught by application code before a socket opens.
const pg = require("pg");
pg.Pool.prototype.query = deny("PostgreSQL pool query");
pg.Pool.prototype.connect = deny("PostgreSQL pool connection");
pg.Client.prototype.query = deny("PostgreSQL client query");
pg.Client.prototype.connect = deny("PostgreSQL client connection");
