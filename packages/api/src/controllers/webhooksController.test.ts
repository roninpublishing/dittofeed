import { db } from "backend-lib/src/db";
import {
  newsletter,
  newsletterWebhookReceipt,
  publisher,
  publisherSendgridAccount,
  sendingConnection,
} from "backend-lib/src/db/publisherSchema";
import {
  secret,
  telnyxEmailReceipt,
  workspace,
} from "backend-lib/src/db/schema";
import * as amazonSes from "backend-lib/src/destinations/amazonses";
import {
  AmazonSNSEventTypes,
  AmazonSNSNotificationEvent,
} from "backend-lib/src/types";
import { createWorkspace } from "backend-lib/src/workspaces";
import { generateKeyPairSync, randomUUID, sign } from "crypto";
import { eq } from "drizzle-orm";
import fastify, { FastifyInstance } from "fastify";
import { SecretNames } from "isomorphic-lib/src/constants";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";
import { EmailProviderType } from "isomorphic-lib/src/types";
import { err, ok } from "neverthrow";

import webhooksController from "./webhooksController";

describe("native Telnyx webhook authentication and durable receipt", () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey
    .export({ type: "spki", format: "der" })
    .subarray(-32)
    .toString("base64");
  let app: FastifyInstance;
  let workspaceId: string;
  let eventId: string;
  let rawBody: string;

  beforeEach(async () => {
    workspaceId = (await createWorkspace({ name: randomUUID() }).then(unwrap))
      .id;
    await db()
      .insert(secret)
      .values({
        workspaceId,
        name: SecretNames.Telnyx,
        configValue: { type: EmailProviderType.Telnyx, publicKey },
      });
    eventId = randomUUID();
    // Whitespace and Unicode deliberately distinguish these bytes from a reserialized body.
    rawBody = `{ "data": {"id":"${eventId}","event_type":"email.opened","record_type":"event","occurred_at":"${new Date().toISOString()}","payload":{"id":"${randomUUID()}","to":{"email":"recipient@example.com"},"user_agent":"é privacy proxy","metadata":{"workspaceId":"untrusted","userId":"untrusted"}}}, "meta":{"attempt":1} }\n`;
    app = fastify();
    await app.register(webhooksController);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  function headers(
    body = rawBody,
    timestamp = String(Math.floor(Date.now() / 1000)),
  ) {
    return {
      "content-type": "application/json",
      "telnyx-timestamp": timestamp,
      "telnyx-signature-ed25519": sign(
        null,
        new TextEncoder().encode(`${timestamp}|${body}`),
        keys.privateKey,
      ).toString("base64"),
    };
  }

  it("accepts an active Parent credential owner and durably deduplicates exact raw callback evidence", async () => {
    // Parent workspaces own inherited credentials, although direct native ingestion disallows them.
    await db()
      .update(workspace)
      .set({ type: "Parent" })
      .where(eq(workspace.id, workspaceId));
    const response = await app.inject({
      method: "POST",
      url: `/telnyx?workspaceId=${workspaceId}`,
      payload: rawBody,
      headers: {
        ...headers(),
        authorization: "must-not-be-evidence",
        cookie: "must-not-be-evidence",
      },
    });
    expect(response.statusCode).toBe(202);
    const retryBody = rawBody.replace('"attempt":1', '"attempt":2');
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/telnyx?workspaceId=${workspaceId}`,
          payload: retryBody,
          headers: headers(retryBody),
        })
      ).statusCode,
    ).toBe(202);
    const rows = await db()
      .select()
      .from(telnyxEmailReceipt)
      .where(eq(telnyxEmailReceipt.credentialWorkspaceId, workspaceId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventId,
      rawBody,
      disposition: "pending",
      attempts: 0,
    });
    expect(rows[0]?.evidenceHeaders).not.toHaveProperty("authorization");
    expect(rows[0]?.evidenceHeaders).not.toHaveProperty("cookie");
  });

  it("rejects tampering and freshly delivered callbacks signed outside both replay boundaries", async () => {
    const badBodies = [
      rawBody.replace("email.opened", "email.clicked"),
      JSON.stringify(JSON.parse(rawBody)),
    ];
    await Promise.all(
      badBodies.map(async (body) => {
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/telnyx?workspaceId=${workspaceId}`,
              payload: body,
              headers: headers(),
            })
          ).statusCode,
        ).toBe(401);
      }),
    );
    await Promise.all(
      [-301, 301].map(async (offset) => {
        const timestamp = String(Math.floor(Date.now() / 1000) + offset);
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/telnyx?workspaceId=${workspaceId}`,
              payload: rawBody,
              headers: headers(rawBody, timestamp),
            })
          ).statusCode,
        ).toBe(401);
      }),
    );
    expect(
      await db()
        .select()
        .from(telnyxEmailReceipt)
        .where(eq(telnyxEmailReceipt.credentialWorkspaceId, workspaceId)),
    ).toHaveLength(0);
  });

  it("never takes tenant identity or verification credentials from callback metadata", async () => {
    const otherId = (await createWorkspace({ name: randomUUID() }).then(unwrap))
      .id;
    const response = await app.inject({
      method: "POST",
      url: `/telnyx?workspaceId=${otherId}`,
      payload: rawBody,
      headers: headers(),
    });
    expect(response.statusCode).toBe(401);
    await db()
      .update(secret)
      .set({ configValue: { type: EmailProviderType.Telnyx } })
      .where(eq(secret.workspaceId, workspaceId));
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/telnyx?workspaceId=${workspaceId}`,
          payload: rawBody,
          headers: headers(),
        })
      ).statusCode,
    ).toBe(401);
    expect(
      await db()
        .select()
        .from(telnyxEmailReceipt)
        .where(eq(telnyxEmailReceipt.eventId, eventId)),
    ).toHaveLength(0);
  });

  it("rejects inactive account credentials and missing authentication headers", async () => {
    await db()
      .update(workspace)
      .set({ status: "Tombstoned" })
      .where(eq(workspace.id, workspaceId));
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/telnyx?workspaceId=${workspaceId}`,
          payload: rawBody,
          headers: headers(),
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/telnyx?workspaceId=${workspaceId}`,
          payload: rawBody,
          headers: { "content-type": "application/json" },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("preserves signed unknown payload shapes but rejects an invalid envelope", async () => {
    const unknown = JSON.stringify({
      data: {
        id: eventId,
        event_type: "email_domain.verified",
        record_type: "event",
        occurred_at: new Date().toISOString(),
        payload: { domain: "example.com", novel_evidence: [1, 2] },
      },
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/telnyx?workspaceId=${workspaceId}`,
          payload: unknown,
          headers: headers(unknown),
        })
      ).statusCode,
    ).toBe(202);
    const invalid = JSON.stringify({ data: { id: randomUUID() } });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/telnyx?workspaceId=${workspaceId}`,
          payload: invalid,
          headers: headers(invalid),
        })
      ).statusCode,
    ).toBe(400);
    const [row] = await db()
      .select()
      .from(telnyxEmailReceipt)
      .where(eq(telnyxEmailReceipt.credentialWorkspaceId, workspaceId));
    expect(row).toMatchObject({
      rawBody: unknown,
      disposition: "raw_only_unsupported",
    });
  });

  it.each(["2026-02-30T12:00:00Z", "2026-11-20", "2026-11-20T24:00:00Z"])(
    "rejects a signed invalid RFC3339 occurrence time %s",
    async (occurredAt) => {
      const body = JSON.stringify({
        data: {
          id: eventId,
          event_type: "email.clicked",
          record_type: "event",
          occurred_at: occurredAt,
          payload: {},
        },
      });
      const response = await app.inject({
        method: "POST",
        url: `/telnyx?workspaceId=${workspaceId}`,
        payload: body,
        headers: headers(body),
      });
      expect(response.statusCode).toBe(400);
      const receipts = await db()
        .select()
        .from(telnyxEmailReceipt)
        .where(eq(telnyxEmailReceipt.credentialWorkspaceId, workspaceId));
      expect(receipts).toEqual([]);
    },
  );

  it("does not expose the removed provider callback", async () => {
    expect(
      (await app.inject({ method: "POST", url: "/resend", payload: {} }))
        .statusCode,
    ).toBe(404);
  });
});

describe("SES webhook signature boundary", () => {
  let app: FastifyInstance;

  function notification(): AmazonSNSNotificationEvent {
    return {
      Type: AmazonSNSEventTypes.Notification,
      Message: JSON.stringify({ privateRecipient: "recipient@example.com" }),
      MessageId: randomUUID(),
      TopicArn: "arn:aws:sns:us-east-1:123456789012:email-events",
      Timestamp: "2026-11-20T12:30:00Z",
      SignatureVersion: "1",
      Signature: "signature",
      SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
      UnsubscribeURL: "https://sns.us-east-1.amazonaws.com/unsubscribe",
    };
  }

  beforeEach(async () => {
    app = fastify();
    await app.register(webhooksController);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it("does not process notification identities before signature verification succeeds", async () => {
    const body = notification();
    const validate = jest
      .spyOn(amazonSes, "validSNSSignature")
      .mockResolvedValue(err(new Error("invalid")));
    const process = jest
      .spyOn(amazonSes, "handleSesNotification")
      .mockResolvedValue(ok(undefined));
    const response = await app.inject({
      method: "POST",
      url: "/amazon-ses",
      payload: JSON.stringify(body),
      headers: { "content-type": "text/plain" },
    });
    expect(response.statusCode).toBe(401);
    expect(validate).toHaveBeenCalledWith(body);
    expect(process).not.toHaveBeenCalled();
  });

  it("passes the original SNS MessageId through the verified envelope, including retries", async () => {
    const body = notification();
    const calls: string[] = [];
    jest.spyOn(amazonSes, "validSNSSignature").mockImplementation((payload) => {
      calls.push("verified");
      return Promise.resolve(ok(payload));
    });
    const process = jest
      .spyOn(amazonSes, "handleSesNotification")
      .mockImplementation(() => {
        calls.push("processed");
        return Promise.resolve(ok(undefined));
      });
    const request = async () => {
      const response = await app.inject({
        method: "POST",
        url: "/amazon-ses",
        payload: JSON.stringify(body),
        headers: { "content-type": "text/plain" },
      });
      expect(response.statusCode).toBe(200);
    };
    // The retry must begin only after the first verified notification is processed.
    await request();
    await request();
    expect(calls).toEqual(["verified", "processed", "verified", "processed"]);
    expect(process.mock.calls).toEqual([[body], [body]]);
  });
});

describe("SendGrid native signed callback bytes", () => {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  let app: FastifyInstance;
  let workspaceId: string;

  beforeEach(async () => {
    workspaceId = (await createWorkspace({ name: randomUUID() }).then(unwrap))
      .id;
    await db()
      .insert(secret)
      .values({
        workspaceId,
        name: SecretNames.SendGrid,
        configValue: {
          type: EmailProviderType.SendGrid,
          webhookKey: keys.publicKey
            .export({ type: "spki", format: "der" })
            .toString("base64"),
        },
      });
    app = fastify();
    await app.register(webhooksController);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("authenticates the raw Buffer before accepting click observations and rejects tampering", async () => {
    const body = `[ { "email":"recipient@example.com","event":"click","timestamp":1795176000,"sg_event_id":"click-one","sg_message_id":"provider-send","workspaceId":"${workspaceId}","userId":"contact","messageId":"internal-send","url":"https://example.com/é" } ]\n`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = {
      "content-type": "application/json",
      "x-twilio-email-event-webhook-timestamp": timestamp,
      "x-twilio-email-event-webhook-signature": sign(
        "sha256",
        new TextEncoder().encode(`${timestamp}${body}`),
        keys.privateKey,
      ).toString("base64"),
    };
    const tampered = await app.inject({
      method: "POST",
      url: "/sendgrid",
      payload: body.replace("click-one", "click-two"),
      headers,
    });
    expect(tampered.statusCode).toBe(400);
    const accepted = await app.inject({
      method: "POST",
      url: "/sendgrid",
      payload: body,
      headers,
    });
    expect(accepted.statusCode).toBe(200);
  });

  it("uses a signed connection route and durably deduplicates unknown correlations without trusting tenant metadata", async () => {
    const childId = (await createWorkspace({ name: randomUUID() }).then(unwrap))
      .id;
    const connectionId = randomUUID();
    const accountId = randomUUID();
    await db().insert(publisher).values({ workspaceId });
    await db().insert(publisherSendgridAccount).values({
      id: accountId,
      publisherId: workspaceId,
      name: "Signed callback fixture",
    });
    await db().insert(newsletter).values({
      workspaceId: childId,
      publisherId: workspaceId,
      slug: "signed-callback",
    });
    await db()
      .insert(sendingConnection)
      .values({
        id: connectionId,
        accountId,
        publisherId: workspaceId,
        newsletterId: childId,
        username: "signed-subuser",
        administrativeEmail: "admin@example.com",
        webhookKeys: [
          {
            key: keys.publicKey
              .export({ type: "spki", format: "pem" })
              .toString(),
          },
        ],
      });
    try {
      const body = `[ { "email":"recipient@example.com","event":"click","timestamp":1795176000,"sg_event_id":"connection-click-one","sg_message_id":"unknown-provider-send","workspaceId":"${workspaceId}","userId":"forged-contact","url":"https://example.com/é" } ]`;
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signedBytes = Buffer.from(`${timestamp}${body}`);
      const headers = {
        "content-type": "application/json",
        "x-twilio-email-event-webhook-timestamp": timestamp,
        "x-twilio-email-event-webhook-signature": sign(
          "sha256",
          new Uint8Array(
            signedBytes.buffer,
            signedBytes.byteOffset,
            signedBytes.byteLength,
          ),
          keys.privateKey,
        ).toString("base64"),
      };
      const url = `/sendgrid/connections/${connectionId}`;
      expect(
        (
          await app.inject({
            method: "POST",
            url,
            payload: body.replace("connection-click-one", "tampered"),
            headers,
          })
        ).statusCode,
      ).toBe(401);
      const request = async () => {
        expect(
          (await app.inject({ method: "POST", url, payload: body, headers }))
            .statusCode,
        ).toBe(202);
      };
      // Exercise an acknowledged retry rather than racing two initial deliveries.
      await request();
      await request();
      const rows = await db()
        .select()
        .from(newsletterWebhookReceipt)
        .where(eq(newsletterWebhookReceipt.connectionId, connectionId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        eventId: "connection-click-one",
        sendId: null,
        processedAt: null,
      });
      expect(rows[0]?.encryptedPayload).not.toBeNull();
      expect(JSON.stringify(rows)).not.toContain("forged-contact");
    } finally {
      await db().delete(workspace).where(eq(workspace.id, childId));
      await db()
        .delete(publisher)
        .where(eq(publisher.workspaceId, workspaceId));
    }
  });
});
