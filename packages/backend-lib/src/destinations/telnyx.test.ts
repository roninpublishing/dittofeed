import axios from "axios";
import { createHash } from "crypto";

import {
  completeTelnyxSend,
  prepareTelnyxSend,
  TelnyxSendConflictError,
} from "../messaging/telnyxState";
import { sendMail, TelnyxMailData, TelnyxRetryableError } from "./telnyx";

jest.mock("axios");
jest.mock("../messaging/telnyxState", () => ({
  prepareTelnyxSend: jest.fn(),
  completeTelnyxSend: jest.fn(),
  TelnyxSendConflictError: class extends Error {},
}));

const post = jest.mocked(axios.post);
const prepare = jest.mocked(prepareTelnyxSend);
const complete = jest.mocked(completeTelnyxSend);
const now = Date.parse("2026-11-20T12:00:00Z");
const id = "70028660-2748-4f19-a782-46268c3960de";
const providerMessageId = "1c428b8a-8414-489f-a2f9-97ead38b30ab";

function mailData(): TelnyxMailData {
  return {
    from: { email: "sender@example.com", name: "Sender" },
    to: ["recipient@example.com"],
    cc: ["copy@example.com"],
    bcc: ["blind@example.com"],
    subject: "A subject",
    html_body: "<p>Hello</p>",
    text_body: "Hello",
    reply_to: "reply@example.com",
    headers: {
      "X-Campaign": "welcome",
      "List-Unsubscribe": "<https://example.com/unsubscribe>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    metadata: {
      workspaceId: "workspace",
      userId: "user",
      templateId: "template",
      messageId: "logical-message",
    },
    attachments: [{
      filename: "invoice.txt",
      content_type: "text/plain",
      content: "SGVsbG8=",
    }],
    sandbox_mode: true,
  };
}

function input() {
  return {
    apiKey: "private-api-key",
    publicKey: Buffer.alloc(32, 1).toString("base64"),
    mailData: mailData(),
    workspaceId: "workspace",
    credentialWorkspaceId: "parent-workspace",
    messageId: "logical-message",
    userId: "user",
    primaryEmail: "recipient@example.com",
  };
}

function accepted() {
  return {
    status: 202,
    data: {
      data: { id: providerMessageId, record_type: "email_message", status: "queued" },
    },
  };
}

describe("native Telnyx outbound email", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(Date, "now").mockReturnValue(now);
    prepare.mockResolvedValue({ id, providerMessageId: null, createdAt: new Date(now) });
    complete.mockResolvedValue(undefined);
    post.mockResolvedValue(accepted());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("posts the native snake_case payload with attachments, metadata and safe headers", async () => {
    const request = input();
    const result = await sendMail(request);
    expect(result._unsafeUnwrap()).toEqual({ messageId: providerMessageId });
    expect(post).toHaveBeenCalledTimes(1);
    const call = post.mock.calls[0];
    expect(call?.[0]).toBe("https://api.telnyx.com/v2/email_messages");
    const body = call?.[1] as string;
    expect(JSON.parse(body)).toEqual(request.mailData);
    expect(call?.[2]).toMatchObject({
      headers: {
        Authorization: "Bearer private-api-key",
        "Content-Type": "application/json",
        "Idempotency-Key": id,
      },
      maxRedirects: 0,
      timeout: 30000,
    });
    expect(prepare).toHaveBeenCalledWith({
      workspaceId: "workspace",
      credentialWorkspaceId: "parent-workspace",
      messageId: "logical-message",
      userId: "user",
      primaryEmail: "recipient@example.com",
      metadata: request.mailData.metadata,
      requestHash: createHash("sha256").update(body).digest("hex"),
    });
    expect(complete).toHaveBeenCalledWith({ id, providerMessageId });
  });

  it("records RFC 9562 UUIDv7 acceptance without retrying an accepted email", async () => {
    const response = accepted();
    response.data.data.id = "019f5b8f-75a0-7000-8000-000000000001";
    post.mockResolvedValue(response);
    const result = await sendMail(input());
    expect(result._unsafeUnwrap()).toEqual({
      messageId: response.data.data.id,
    });
    expect(complete).toHaveBeenCalledWith({
      id,
      providerMessageId: response.data.data.id,
    });
  });

  it("returns recorded acceptance without another POST even beyond the replay window", async () => {
    prepare.mockResolvedValue({
      id,
      providerMessageId,
      createdAt: new Date(now - 48 * 60 * 60 * 1000),
    });
    expect((await sendMail(input()))._unsafeUnwrap()).toEqual({ messageId: providerMessageId });
    expect(post).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("reuses canonical request bytes, request hash and persisted key after ambiguous acceptance", async () => {
    post.mockRejectedValueOnce(new Error("Bearer private-api-key recipient@example.com"));
    await expect(sendMail(input())).rejects.toEqual(new TelnyxRetryableError());
    const request = input();
    request.mailData.metadata = {
      messageId: "logical-message",
      templateId: "template",
      userId: "user",
      workspaceId: "workspace",
    };
    await sendMail(request);
    expect(post.mock.calls[0]?.[1]).toEqual(post.mock.calls[1]?.[1]);
    expect(prepare.mock.calls[0]?.[0].requestHash).toEqual(prepare.mock.calls[1]?.[0].requestHash);
    expect(post.mock.calls[1]?.[2]?.headers).toMatchObject({ "Idempotency-Key": id });
  });

  it("fails closed when the durable state rejects a changed request", async () => {
    const first = await sendMail(input());
    expect(first.isOk()).toBe(true);
    prepare.mockRejectedValueOnce(new TelnyxSendConflictError());
    const changed = input();
    changed.mailData.html_body = "<p>Changed content</p>";
    expect((await sendMail(changed))._unsafeUnwrapErr().code).toBe("send_conflict");
    expect(prepare.mock.calls[0]?.[0].requestHash).not.toBe(prepare.mock.calls[1]?.[0].requestHash);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it.each([24, 25])("does not resend unknown acceptance after %i hours", async (hours) => {
    prepare.mockResolvedValue({ id, providerMessageId: null, createdAt: new Date(now - hours * 60 * 60 * 1000) });
    expect((await sendMail(input()))._unsafeUnwrapErr().code).toBe("reconciliation_required");
    expect(post).not.toHaveBeenCalled();
  });

  it.each([409, 429, 500, 503])("sanitizes retryable HTTP %i errors", async (status) => {
    post.mockResolvedValue({ status, data: { errors: [{ detail: "recipient@example.com private-api-key" }] } });
    await expect(sendMail(input())).rejects.toEqual(new TelnyxRetryableError());
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 422])("returns a sanitized permanent HTTP %i failure", async (status) => {
    post.mockResolvedValue({ status, data: { errors: [{ code: "secret", detail: "recipient@example.com private-api-key" }] } });
    expect((await sendMail(input()))._unsafeUnwrapErr()).toEqual({
      code: `http_${status}`,
      message: "Telnyx rejected the email request.",
      status,
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    { status: 200, data: accepted().data },
    { status: 202, data: { data: { id: "not-a-uuid" } } },
    { status: 202, data: { data: { id: providerMessageId, status: "queued", record_type: "unexpected" } } },
  ])("retries an ambiguous or malformed acceptance safely", async (response) => {
    post.mockResolvedValue(response);
    await expect(sendMail(input())).rejects.toEqual(new TelnyxRetryableError());
    expect(complete).not.toHaveBeenCalled();
  });

  it("accepts sandbox status without claiming delivery", async () => {
    const response = accepted();
    response.data.data.status = "sandbox";
    post.mockResolvedValue(response);
    expect((await sendMail(input()))._unsafeUnwrap()).toEqual({ messageId: providerMessageId });
  });

  it("replays the same key if saving acceptance fails", async () => {
    complete.mockRejectedValueOnce(new Error("private database details"));
    await expect(sendMail(input())).rejects.toEqual(new TelnyxRetryableError());
    await sendMail(input());
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]?.[2]?.headers).toEqual(post.mock.calls[1]?.[2]?.headers);
  });

  it("sanitizes persistence errors before making a request", async () => {
    prepare.mockRejectedValueOnce(new Error("private database details"));
    await expect(sendMail(input())).rejects.toEqual(new TelnyxRetryableError());
    expect(post).not.toHaveBeenCalled();
  });

  it.each(["", " "])("requires a stable message ID (%p)", async (messageId) => {
    expect((await sendMail({ ...input(), messageId }))._unsafeUnwrapErr().code).toBe("message_id_required");
    expect(prepare).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it.each(["", "svix-secret", Buffer.alloc(31).toString("base64")])("rejects invalid webhook public keys (%p)", async (publicKey) => {
    expect((await sendMail({ ...input(), publicKey }))._unsafeUnwrapErr().code).toBe("configuration_invalid");
    expect(prepare).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it.each<Record<string, string>>([
    { "X-Example": "value\r\nBcc: stolen@example.com" },
    { "Bad Header": "value" },
    { bCc: "stolen@example.com" },
    { Authorization: "private-key" },
  ])("rejects unsafe custom headers before persisting or sending", async (headers) => {
    const request = input();
    request.mailData.headers = headers;
    expect((await sendMail(request))._unsafeUnwrapErr().code).toBe("headers_invalid");
    expect(prepare).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});
