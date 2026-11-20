#!/usr/bin/env node
/* Source inventory only. Runtime API discovery is /api/admin/openapi.json. */
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const root = path.resolve(__dirname, "../../..");
const excludedDirectories = new Set(["node_modules", "dist", ".next", ".git", "coverage", "test", "tests", "__tests__", "__mocks__", "generated", "drizzle"]);
const sources = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) walk(absolute);
    } else if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name) && !/\.(?:test|spec)\.[^.]+$/.test(entry.name)) {
      sources.push(absolute);
    }
  }
}
walk(path.join(root, "packages"));
const functions = [];
const routes = [];
const registrations = [];
const pages = [];
function sourceName(node, source) {
  if (node.name) return node.name.getText(source);
  const parent = node.parent;
  if (parent && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent))) return parent.name.getText(source);
  if (parent && ts.isBinaryExpression(parent) && parent.right === node) return parent.left.getText(source);
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isFunctionDeclaration(node) && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) return "default";
  if (parent && ts.isCallExpression(parent)) {
    const argument = parent.arguments.indexOf(node);
    return `${parent.expression.getText(source).replace(/\s+/g, " ").slice(0, 160)} callback[${argument}]`;
  }
  return "<anonymous>";
}
for (const absolute of sources) {
  const file = path.relative(root, absolute).split(path.sep).join("/");
  const text = fs.readFileSync(absolute, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length) {
    throw new Error(`Cannot inventory malformed source: ${file}`);
  }
  if (file.startsWith("packages/dashboard/src/pages/")) pages.push(file);
  const visit = (node) => {
    const location = () => source.getLineAndCharacterOfPosition(node.getStart(source));
    if (ts.isFunctionLike(node)) {
      const { line, character } = location();
      const controller = file.startsWith("packages/api/src/controllers/");
      functions.push({
        file, line: line + 1, column: character + 1,
        name: sourceName(node, source), kind: ts.SyntaxKind[node.kind],
        parameters: node.parameters.map((parameter) => parameter.getText(source)),
        returnType: node.type ? node.type.getText(source) : "inferred from implementation",
        documentation: node.jsDoc?.map((comment) => comment.getText(source)).join("\n") || null,
        hasBody: Boolean(node.body),
        boundary: controller ? "controller implementation; not independently exposed" : "internal implementation; not independently exposed",
      });
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const first = node.arguments[0];
      const receiver = node.expression.expression.getText(source);
      const literalPath = first && ts.isStringLiteralLike(first) && first.text.startsWith("/");
      const symbolicPath = first && !ts.isStringLiteralLike(first) && /^(?:app|routes|fastify|scope|f|server)(?:\.|$)/.test(receiver);
      if (["get", "post", "put", "patch", "delete", "head", "options", "trace"].includes(method) && node.arguments.length >= 2 && (literalPath || symbolicPath) && file.startsWith("packages/api/src/")) {
        routes.push({ file, line: location().line + 1, method: method.toUpperCase(), localPath: literalPath ? first.text : null, pathExpression: first.getText(source), boundary: "source declaration; registration/auth mode determines reachability" });
      }
      if (method === "register" && first && file === "packages/api/src/buildApp/router.ts") {
        const options = node.arguments[1];
        const prefix = options && ts.isObjectLiteralExpression(options) ? options.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(source) === "prefix") : undefined;
        registrations.push({ file, line: location().line + 1, controller: first.getText(source).replace(/\s+/g, " ").slice(0, 160), prefix: prefix && ts.isStringLiteralLike(prefix.initializer) ? prefix.initializer.text : null });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
const directory = path.join(__dirname, "../generated");
fs.mkdirSync(directory, { recursive: true });
const artifacts = {
  "code-functions.json": { formatVersion: 1, generator: "node packages/docs/scripts/generate-code-inventory.cjs", scope: "All TypeScript/JavaScript package sources, including scripts, declarations, methods, accessors, constructors, signatures and anonymous callbacks. Excludes dependencies, compiled output, tests/mocks, generated output and historical Drizzle migrations.", sourceFiles: sources.map((file) => path.relative(root, file).split(path.sep).join("/")), functionCount: functions.length, functions },
  "api-source-map.json": { formatVersion: 1, authority: "Source mapping only, not a supported-operation allowlist. Use authenticated GET /api/admin/openapi.json for actual registered operations and schemas.", registrations, routes, dashboardPages: pages },
};
for (const [name, contents] of Object.entries(artifacts)) {
  const output = path.join(directory, name);
  const serialized = `${JSON.stringify(contents, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    if (!fs.existsSync(output) || fs.readFileSync(output, "utf8") !== serialized) {
      console.error(`Stale inventory: ${path.relative(root, output)}`);
      process.exitCode = 1;
    }
  } else fs.writeFileSync(output, serialized);
}
console.log(`${sources.length} source files, ${functions.length} functions, ${routes.length} route declarations`);
