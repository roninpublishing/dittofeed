import multipart from "@fastify/multipart";
import { upsertSegment } from "backend-lib/src/segments";
import { createWorkspace } from "backend-lib/src/workspaces";
import { randomUUID } from "crypto";
import fastify from "fastify";
import { SEGMENT_ID_HEADER, WORKSPACE_ID_HEADER } from "isomorphic-lib/src/constants";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";
import { TYPE_REFS } from "isomorphic-lib/src/typeRefs";
import { SegmentNodeType } from "isomorphic-lib/src/types";

import segmentsController from "./segmentsController";

describe("manual segment CSV workspace boundary", () => {
  it("does not import into a segment owned by another workspace", async () => {
    const caller = unwrap(await createWorkspace({ name: randomUUID() }));
    const owner = unwrap(await createWorkspace({ name: randomUUID() }));
    const segmentId = randomUUID();
    unwrap(await upsertSegment({ id: segmentId, name: "Foreign manual segment", workspaceId: owner.id, definition: { entryNode: { id: randomUUID(), type: SegmentNodeType.Manual, version: 1 }, nodes: [] } }));
    const app = fastify();
    TYPE_REFS.forEach((schema) => app.addSchema(schema));
    await app.register(multipart);
    await app.register(segmentsController);
    try {
      const boundary = "csv-workspace-regression";
      const response = await app.inject({
        method: "POST",
        url: "/upload-csv",
        headers: {
          [WORKSPACE_ID_HEADER]: caller.id,
          [SEGMENT_ID_HEADER]: segmentId,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="contacts.csv"\r\nContent-Type: text/csv\r\n\r\nid,email\ncontact,person@example.com\n\r\n--${boundary}--\r\n`,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ message: "Segment not found." });
    } finally {
      await app.close();
    }
  });
});
