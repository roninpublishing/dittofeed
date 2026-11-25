import worker from "../src/index";
import type { Env } from "../src/index";

// Native workerd-only fixture: expose runtime observations and streams that an
// ordinary Node HTTP client cannot synthesize on Cloudflare's incoming Request.
export default {
  ...worker,
  fetch(incoming: Request, env: Env & { FIXTURE_BODY?: string; FIXTURE_METADATA?: string }, ctx: ExecutionContext) {
    let request = incoming;
    if (env.FIXTURE_BODY) {
      const mode = env.FIXTURE_BODY;
      request = new Request(incoming, {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"));
            if (mode === "error") controller.error(new Error("private stream diagnostic"));
          },
        }),
      });
    }
    let metadata: unknown;
    if (env.FIXTURE_METADATA) {
      metadata = JSON.parse(env.FIXTURE_METADATA);
      Object.defineProperty(request, "fixtureMetadata", { value: metadata });
      Object.defineProperty(request, "credentials", { value: "same-origin" });
    }
    const reply = worker.fetch(request, env, ctx);
    // Snapshot must not retain a live mutable reference after fetch returns.
    if (metadata && typeof metadata === "object" && "mutable" in metadata) metadata.mutable = "changed-after-response";
    return reply;
  },
};
