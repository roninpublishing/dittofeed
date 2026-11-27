const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const generatorPath = path.join(__dirname, "generate-code-inventory.cjs");
const generator = fs.readFileSync(generatorPath, "utf8");

test("inventories source functions without compiled Next.js preview bundles", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-code-inventory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixtures = {
    "packages/example/src/index.ts": "export function sourceFunction() { return true; }",
    "packages/example/.next/static/chunks/page.js": "function canonicalBuild() {}",
    "packages/example/.next-ui-preview/static/chunks/page.js": "function previewBuild() {}",
    "packages/example/.next-ui-proof/server/page.js": "function proofBuild() {}",
  };
  for (const [relative, contents] of Object.entries(fixtures)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  const run = (process) => vm.runInNewContext(generator, {
    require,
    __dirname: path.join(root, "packages/docs/scripts"),
    process,
    console,
  }, { filename: generatorPath });

  run({ argv: [] });
  const inventory = JSON.parse(fs.readFileSync(
    path.join(root, "packages/docs/generated/code-functions.json"), "utf8",
  ));
  assert.deepEqual(inventory.sourceFiles, ["packages/example/src/index.ts"]);
  assert.deepEqual(inventory.functions.map(({ name }) => name), ["sourceFunction"]);

  const checkProcess = { argv: ["node", generatorPath, "--check"] };
  run(checkProcess);
  assert.equal(checkProcess.exitCode, undefined);
});
