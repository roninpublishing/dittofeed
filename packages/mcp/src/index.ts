import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ApiBridge, loadBridgeConfig } from "./api";
import { createMcpServer } from "./server";

async function main(): Promise<void> {
  const bridge = new ApiBridge(loadBridgeConfig(process.env));
  const document = await bridge.discover();
  const handle = await serveStdio(() => createMcpServer(bridge, document), {
    onerror: () => { process.stderr.write("MCP protocol error\n"); },
  });
  const stop = () => { void handle.close(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

void main().catch(() => {
  // stdout belongs exclusively to MCP JSON-RPC. Do not dump configuration or request errors.
  process.stderr.write("MCP startup failed. Check API connectivity, URL, workspace, key, scopes, and live OpenAPI compatibility.\n");
  process.exitCode = 1;
});
