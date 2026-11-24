/* Isolated behavioral tests: no application bootstrap, dotenv files, SDK/network,
 * workers or service-backed global Jest setup. Run with:
 * node --test scripts/temporal-cloud.test.cjs
 * Uses the repository's existing TypeScript and TypeBox development dependencies.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const { Type } = require('@sinclair/typebox');
const { Value } = require('@sinclair/typebox/value');
const { constantCase } = require('change-case');
const root = path.resolve(__dirname, '..');

// Only explicitly allowed imports can execute; any accidental external transport
// import (including net/http/child_process) fails closed before test execution.
function load(relative, imports = {}, env = {}, onLog = () => {}) {
  const filename = path.join(root, relative);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  const safeRequire = (name) => {
    assert.ok(Object.hasOwn(imports, name), `Denied import ${name} from ${relative}`);
    return imports[name];
  };
  safeRequire.resolve = (name) => {
    assert.match(name, /^backend-lib\/src\/temporal\/(workflows|workflowInboundCallsInterceptor)$/);
    return name;
  };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, require: safeRequire,
    process: { env }, URL, URLSearchParams,
    console: { log: onLog, info: onLog, error: onLog },
  }, { filename });
  return module.exports;
}
test('client connection enables TLS, API key and namespace metadata only with a key', async () => {
  for (const key of ['synthetic-test-key', '', undefined]) {
    for (const timeout of [undefined, 4321]) {
      const calls = [];
      const connection = {};
      const connect = load('packages/backend-lib/src/temporal/connection.ts', {
        '@temporalio/client': { Connection: { connect: async (options) => { calls.push(plain(options)); return connection; } } },
        '../config': () => ({ temporalAddress: 'test:7233', temporalNamespace: 'test.namespace', temporalApiKey: key, temporalConnectionTimeout: timeout }),
      }).default;
      assert.equal(await connect(), connection);
      assert.equal(await connect(), connection);
      assert.deepEqual(calls, [{
        address: 'test:7233',
        ...(timeout === undefined ? {} : { connectTimeout: timeout }),
        ...(key ? { tls: true, apiKey: key, metadata: { 'temporal-namespace': 'test.namespace' } } : {}),
      }]);
    }
  }
});

test('native helper enables cloud options without changing local option shape', async () => {
  for (const key of ['synthetic-test-key', '', undefined]) {
    const calls = [];
    const connection = {};
    const createConnection = load('packages/backend-lib/src/temporal/createConnection.ts', {
      '@temporalio/worker': { NativeConnection: { connect: async (options) => { calls.push(plain(options)); return connection; } } },
      '../config': () => ({ temporalAddress: 'test:7233', temporalNamespace: 'test.namespace', temporalApiKey: key }),
    }).default;
    assert.equal(await createConnection(), connection);
    assert.deepEqual(calls, [{ address: 'test:7233', ...(key ? { tls: true, apiKey: key, metadata: { 'temporal-namespace': 'test.namespace' } } : {}) }]);
  }
});

test('worker native connection enables cloud options without starting a worker', async () => {
  for (const key of ['synthetic-test-key', '', undefined]) {
    const calls = [];
    const connection = {};
    const fakeWorker = {};
    let createdOptions;
    const { buildWorker } = load('packages/worker/src/buildWorker.ts', {
      '@temporalio/interceptors-opentelemetry/lib/worker': {},
      '@temporalio/worker': {
        Runtime: { install() {} },
        NativeConnection: { connect: async (options) => { calls.push(plain(options)); return connection; } },
        Worker: { create: async (options) => { createdOptions = options; return fakeWorker; } },
        appendDefaultInterceptors: (interceptors) => interceptors,
        defaultSinks: () => ({}),
      },
      'backend-lib/src/config': () => ({ temporalAddress: 'test:7233', temporalNamespace: 'test.namespace', temporalApiKey: key }),
      'backend-lib/src/logger': () => ({ info() {} }),
      'backend-lib/src/temporal/activities': {},
      'backend-lib/src/temporal/activityInboundInterceptor': {},
      'backend-lib/src/temporal/connectWorkflowClient': async () => ({}),
      'backend-lib/src/workerLogger': {},
      './config': () => ({ taskQueue: 'test-queue' }),
    });
    assert.equal(await buildWorker(), fakeWorker);
    assert.equal(createdOptions.connection, connection);
    assert.equal(createdOptions.namespace, 'test.namespace');
    assert.equal(createdOptions.taskQueue, 'test-queue');
    assert.deepEqual(calls, [{ address: 'test:7233', ...(key ? { tls: true, apiKey: key, metadata: { 'temporal-namespace': 'test.namespace' } } : {}) }]);
  }
});

const plain = (value) => JSON.parse(JSON.stringify(value));
const enums = {
  NodeEnvEnum: { Production: 'production', Development: 'development', Test: 'test' },
  BoolStr: Type.Union([Type.Literal('true'), Type.Literal('false')]),
  AuthMode: Type.String(), KafkaSaslMechanism: Type.String(),
  LogLevel: Type.String(), SourceControlProvider: Type.String(), WriteMode: Type.String(),
};
function loadConfig(env) {
  const loader = load('packages/backend-lib/src/config/loader.ts', {
    '@sinclair/typebox': { Type }, 'change-case': { constantCase },
    dotenv: { config() {} }, path,
    '../dir': { findBaseDir: () => root }, '../types': enums,
    '../formatRegistry': { registerFormats() {} },
    'isomorphic-lib/src/resultHandling/resultUtils': { unwrap: (r) => { if (r.error) throw r.error; return r.value; } },
    'isomorphic-lib/src/resultHandling/schemaValidation': {
      schemaValidate: (value, schema) => Value.Check(schema, value)
        ? { value } : { error: new Error(JSON.stringify([...Value.Errors(schema, value)])) },
    },
  }, env);
  return load('packages/backend-lib/src/config.ts', {
    '@sinclair/typebox': { Type },
    'isomorphic-lib/src/numbers': load('packages/isomorphic-lib/src/numbers.ts'),
    'isomorphic-lib/src/urls': load('packages/isomorphic-lib/src/urls.ts'),
    querystring: require('node:querystring'), url: require('node:url'),
    './types': enums, './config/loader': loader,
    './apiBase': load('packages/backend-lib/src/apiBase.ts', { './types': enums }),
  }, env).default;
}

test('TEMPORAL_API_KEY maps through the real env loader and config transform', () => {
  const env = { NODE_ENV: 'test', TEMPORAL_API_KEY: 'synthetic-test-key', TEMPORAL_NAMESPACE: 'test.namespace' };
  assert.equal(loadConfig(env)().temporalApiKey, 'synthetic-test-key');
  assert.equal(env.TEMPORAL_API_KEY, 'synthetic-test-key');
});

test('config keeps no-key and empty-key local defaults', () => {
  for (const key of [undefined, '']) {
    const env = { NODE_ENV: 'test', ...(key === undefined ? {} : { TEMPORAL_API_KEY: key }) };
    const config = loadConfig(env)();
    assert.equal(config.temporalApiKey, key);
    assert.equal(config.temporalNamespace, 'default');
    assert.equal(config.temporalAddress, 'localhost:7233');
  }
});

test('cutover preflight authenticates Cloud inspection while preserving no-key local options', { timeout: 5000 }, async () => {
  for (const key of ['synthetic-test-key', '', undefined]) {
    const calls = [];
    let clientNamespace;
    await new Promise((resolve, reject) => {
      load('packages/backend-lib/scripts/smsCutoverPreflight.ts', {
        '@temporalio/client': {
          Connection: { connect: async (options) => {
            calls.push(plain(options));
            return { close: async () => {} };
          } },
          Client: class {
            constructor(options) {
              clientNamespace = options.namespace;
              this.workflow = { list: async function* () {} };
            }
          },
        },
        '@temporalio/common': { defaultPayloadConverter: {
          fromPayload() { throw new Error('Unexpected workflow payload'); },
        } },
        pg: { Pool: class {
          async connect() {
            return { query: async () => ({ rows: [] }), release() {} };
          }
          async end() {}
        } },
      }, {
        DATABASE_URL: 'postgresql://fixture',
        TEMPORAL_ADDRESS: 'test:7233',
        TEMPORAL_NAMESPACE: 'test.namespace',
        ...(key === undefined ? {} : { TEMPORAL_API_KEY: key }),
      }, (message) => {
        if (/^Cutover preflight passed/.test(message)) resolve();
        else if (/incomplete|Cutover blocked/.test(message)) reject(new Error(message));
      });
    });
    assert.equal(clientNamespace, 'test.namespace');
    assert.deepEqual(calls, [{
      address: 'test:7233',
      connectTimeout: 10000,
      ...(key ? { tls: true, apiKey: key, metadata: { 'temporal-namespace': 'test.namespace' } } : {}),
    }]);
  }
});
