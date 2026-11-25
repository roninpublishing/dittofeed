const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const source = readFileSync(path.join(__dirname, "../packages/dashboard/src/lib/workspaceSelection.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const exported = {};
new Function("exports", compiled)(exported);
const { workspaceSelection } = exported;

function membership(id, parentWorkspaceId = null) {
  return { workspaceId: id, workspaceName: id, parentWorkspaceId, workspaceMemberId: "member", role: "Admin" };
}

test("workspace choices exclude newsletters", () => {
  const selected = workspaceSelection([membership("workspace-a"), membership("newsletter-a", "workspace-a"), membership("workspace-b")], { id: "workspace-a" });
  assert.deepEqual(selected.workspaces.map(option => option.id), ["workspace-a", "workspace-b"]);
});

test("opening a newsletter keeps its containing workspace selected", () => {
  const selected = workspaceSelection([membership("workspace-a"), membership("newsletter-a", "workspace-a")], { id: "newsletter-a", parentWorkspaceId: "workspace-a" });
  assert.equal(selected.currentWorkspace.id, "workspace-a");
  assert.deepEqual(selected.otherNewsletters, []);
});

test("newsletter-only membership never invents parent workspace access", () => {
  const selected = workspaceSelection([membership("newsletter-a", "workspace-a")], { id: "newsletter-a", parentWorkspaceId: "workspace-a" });
  assert.deepEqual(selected.workspaces, []);
  assert.equal(selected.currentWorkspace, undefined);
  assert.equal(selected.currentNewsletter.id, "newsletter-a");
});

test("direct newsletter memberships remain reachable alongside workspace access", () => {
  const selected = workspaceSelection([membership("workspace-a"), membership("newsletter-a", "workspace-a"), membership("newsletter-b", "workspace-b")], { id: "workspace-a" });
  assert.deepEqual(selected.otherNewsletters.map(option => option.id), ["newsletter-b"]);
});

test("selection never falls back to a different authorized workspace", () => {
  const selected = workspaceSelection([membership("workspace-a"), membership("newsletter-b", "workspace-b")], { id: "newsletter-b", parentWorkspaceId: "workspace-b" });
  assert.equal(selected.currentWorkspace, undefined);
  assert.equal(selected.currentNewsletter.id, "newsletter-b");
});

test("missing membership does not fabricate a current workspace", () => {
  const selected = workspaceSelection([membership("workspace-a")], { id: "removed" });
  assert.equal(selected.currentWorkspace, undefined);
  assert.equal(selected.currentNewsletter, undefined);
});
