import axios from "axios";
import { createHash } from "crypto";
import { err, ok, Result } from "neverthrow";

import {
  completeTelnyxSend,
  prepareTelnyxSend,
  TelnyxSendConflictError,
} from "../messaging/telnyxState";

const PROVIDER_MESSAGE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TelnyxMailData {
  from: string | { email: string; name: string };
  to: string[];
  subject: string;
  html_body?: string;
  text_body?: string;
  reply_to?: string;
  cc?: string[];
  bcc?: string[];
  headers?: Record<string, string>;
  metadata: Record<string, string>;
  attachments?: {
    filename: string;
    content_type: string;
    content: string;
  }[];
  sandbox_mode?: boolean;
}

export interface TelnyxSendFailure {
  code: string;
  message: string;
  status?: number;
}

// Never attach the original error: HTTP/DB errors can contain credentials or PII.
export class TelnyxRetryableError extends Error {
  constructor() {
    super("Telnyx email acceptance is unconfirmed; retry the same logical send.");
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "TelnyxRetryableError";
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const RESERVED_HEADERS: Record<string, true> = {
  authorization: true,
  "proxy-authorization": true,
  host: true,
  "content-length": true,
  "content-type": true,
  "transfer-encoding": true,
  connection: true,
  from: true,
  to: true,
  cc: true,
  bcc: true,
  "reply-to": true,
  subject: true,
  "idempotency-key": true,
};

function safeHeaders(headers: Record<string, string> | undefined): boolean {
  return Object.entries(headers ?? {}).every(
    ([name, value]) =>
      /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) &&
      !Object.prototype.hasOwnProperty.call(RESERVED_HEADERS, name.toLowerCase()) &&
      !/[\r\n\0]/.test(value),
  );
}

export async function sendMail({
  apiKey,
  publicKey,
  mailData,
  workspaceId,
  credentialWorkspaceId,
  messageId,
  userId,
  primaryEmail,
}: {
  apiKey: string;
  publicKey: string;
  mailData: TelnyxMailData;
  workspaceId: string;
  credentialWorkspaceId: string;
  messageId: string;
  userId: string;
  primaryEmail: string;
}): Promise<Result<{ messageId: string }, TelnyxSendFailure>> {
  if (
    !apiKey.trim() ||
    !/^[A-Za-z0-9+/]{43}=$/.test(publicKey) ||
    Buffer.from(publicKey, "base64").toString("base64") !== publicKey
  ) {
    return err({
      code: "configuration_invalid",
      message: "Telnyx requires an API key and a base64-encoded Ed25519 public key.",
    });
  }
  if (!messageId.trim()) {
    return err({
      code: "message_id_required",
      message: "Telnyx requires a stable logical message ID.",
    });
  }
  if (!safeHeaders(mailData.headers)) {
    return err({
      code: "headers_invalid",
      message: "Telnyx custom headers contain an unsafe or reserved header.",
    });
  }
  const body = canonicalJson(mailData);
  const requestHash = createHash("sha256").update(body).digest("hex");
  let prepared: {
    id: string;
    providerMessageId: string | null;
    createdAt: Date;
  };
  try {
    prepared = await prepareTelnyxSend({
      workspaceId,
      credentialWorkspaceId,
      messageId,
      userId,
      primaryEmail,
      metadata: mailData.metadata,
      requestHash,
    });
  } catch (error) {
    if (error instanceof TelnyxSendConflictError) {
      return err({
        code: "send_conflict",
        message: "This logical Telnyx send already exists with different content or identity.",
      });
    }
    throw new TelnyxRetryableError();
  }
  if (prepared.providerMessageId) {
    return ok({ messageId: prepared.providerMessageId });
  }
  if (Date.now() - prepared.createdAt.getTime() >= 24 * 60 * 60 * 1000) {
    return err({
      code: "reconciliation_required",
      message: "Telnyx acceptance is unknown and its idempotency window has expired; reconcile before sending again.",
    });
  }

  let response;
  try {
    response = await axios.post<{
      data?: { id?: string; record_type?: string; status?: string };
    }>("https://api.telnyx.com/v2/email_messages", body, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": prepared.id,
      },
      timeout: 30000,
      maxRedirects: 0,
      validateStatus: () => true,
    });
  } catch {
    throw new TelnyxRetryableError();
  }
  if (
    response.status === 409 ||
    response.status === 429 ||
    response.status >= 500
  ) {
    throw new TelnyxRetryableError();
  }
  if (response.status >= 400 && response.status < 500) {
    return err({
      code: `http_${response.status}`,
      message: "Telnyx rejected the email request.",
      status: response.status,
    });
  }
  const accepted = response.data?.data;
  if (
    response.status !== 202 ||
    typeof accepted?.id !== "string" ||
    !PROVIDER_MESSAGE_ID_PATTERN.test(accepted.id) ||
    accepted.record_type !== "email_message" ||
    (accepted.status !== "queued" && accepted.status !== "sandbox")
  ) {
    // An invalid response does not prove the provider failed to accept the send.
    throw new TelnyxRetryableError();
  }
  try {
    await completeTelnyxSend({
      id: prepared.id,
      providerMessageId: accepted.id,
    });
  } catch {
    throw new TelnyxRetryableError();
  }
  return ok({ messageId: accepted.id });
}
