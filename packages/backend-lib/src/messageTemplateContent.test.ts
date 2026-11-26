import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";
import {
  ChannelType,
  EmailContentsType,
  EmailTemplateResource,
  UpsertMessageTemplateValidationErrorType,
} from "isomorphic-lib/src/types";

import { db } from "./db";
import { messageTemplate, workspace } from "./db/schema";
import { upsertMessageTemplate } from "./messaging";

let workspaceId: string;
const definition = {
  type: ChannelType.Email,
  emailContentsType: EmailContentsType.Code,
  from: "owner@example.test",
  subject: "Template content",
  body: "Hello {{ user.firstName }}",
} satisfies EmailTemplateResource;

beforeEach(async () => {
  workspaceId = randomUUID();
  await db().insert(workspace).values({ id: workspaceId, name: randomUUID() });
});

afterEach(async () => {
  await db().delete(workspace).where(eq(workspace.id, workspaceId));
});

it.each([undefined, null])(
  "rejects creation without content before writing (draft=%s)",
  async (draft) => {
    const id = randomUUID();
    const name = randomUUID();
    const result = await upsertMessageTemplate({ workspaceId, id, name, draft });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("Expected missing-content validation");
    expect(result.error).toEqual({
      type: UpsertMessageTemplateValidationErrorType.MissingContent,
      message: "A template requires a definition or draft.",
    });
    expect(await db().query.messageTemplate.findFirst({
      where: and(eq(messageTemplate.workspaceId, workspaceId), eq(messageTemplate.id, id)),
    })).toBeUndefined();
    expect(await db().query.messageTemplate.findFirst({
      where: and(eq(messageTemplate.workspaceId, workspaceId), eq(messageTemplate.name, name)),
    })).toBeUndefined();

    const created = unwrap(await upsertMessageTemplate({ workspaceId, name, definition }));
    const byName = unwrap(await upsertMessageTemplate({ workspaceId, name }));
    expect(byName.id).toBe(created.id);
    expect(byName.definition).toEqual(definition);
  },
);

it("preserves draft-only metadata updates and rejects clearing the final content without writing", async () => {
  const created = unwrap(await upsertMessageTemplate({
    workspaceId,
    name: randomUUID(),
    draft: definition,
  }));
  const name = randomUUID();
  const renamed = unwrap(await upsertMessageTemplate({ workspaceId, id: created.id, name }));
  expect(renamed.definition).toBeUndefined();
  expect(renamed.draft).toEqual(definition);
  const byName = unwrap(await upsertMessageTemplate({ workspaceId, name }));
  expect(byName.id).toBe(created.id);
  expect(byName.draft).toEqual(definition);
  const before = await db().query.messageTemplate.findFirst({
    where: eq(messageTemplate.id, created.id),
  });

  const cleared = await upsertMessageTemplate({
    workspaceId,
    id: created.id,
    name: "Must not be persisted",
    draft: null,
  });
  expect(cleared.isErr()).toBe(true);
  if (cleared.isOk()) throw new Error("Expected final-content removal to fail");
  expect(cleared.error.type).toBe(UpsertMessageTemplateValidationErrorType.MissingContent);
  expect(await db().query.messageTemplate.findFirst({
    where: eq(messageTemplate.id, created.id),
  })).toEqual(before);

  const updatedDraft = { ...definition, body: "Updated draft {{ user.firstName }}" };
  const updated = unwrap(await upsertMessageTemplate({ workspaceId, name, draft: updatedDraft }));
  expect(updated.id).toBe(created.id);
  expect(updated.draft).toEqual(updatedDraft);
  expect(updated.definition).toBeUndefined();
});

it("allows explicit draft removal when a stored definition remains", async () => {
  const created = unwrap(await upsertMessageTemplate({
    workspaceId,
    name: randomUUID(),
    definition,
    draft: { ...definition, body: "Draft body" },
  }));
  const changed = unwrap(await upsertMessageTemplate({
    workspaceId,
    id: created.id,
    name: "Published template",
    draft: null,
  }));
  expect(changed.definition).toEqual(definition);
  expect(changed.draft).toBeUndefined();
  const stored = await db().query.messageTemplate.findFirst({
    where: eq(messageTemplate.id, created.id),
  });
  expect(stored).toMatchObject({ definition, draft: null });
});

it("rejects metadata-only updates to an empty legacy row but accepts explicitly supplied content", async () => {
  const id = randomUUID();
  const name = randomUUID();
  await db().insert(messageTemplate).values({ workspaceId, id, name });
  const before = await db().query.messageTemplate.findFirst({ where: eq(messageTemplate.id, id) });
  const invalid = await upsertMessageTemplate({ workspaceId, id, name: "Rejected rename" });
  expect(invalid.isErr()).toBe(true);
  if (invalid.isOk()) throw new Error("Expected empty stored content to fail validation");
  expect(invalid.error.type).toBe(UpsertMessageTemplateValidationErrorType.MissingContent);
  expect(await db().query.messageTemplate.findFirst({ where: eq(messageTemplate.id, id) })).toEqual(before);

  const repaired = unwrap(await upsertMessageTemplate({ workspaceId, id, name, definition }));
  expect(repaired.id).toBe(id);
  expect(repaired.definition).toEqual(definition);
});
