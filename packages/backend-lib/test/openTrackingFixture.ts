import { randomUUID } from "crypto";

import { db } from "../src/db";
import {
  newsletter,
  newsletterSend,
  newsletterTrackingDomain,
  publisher,
  publisherSendgridAccount,
  sendingConnection,
} from "../src/db/publisherSchema";
import { workspace } from "../src/db/schema";
import { prepareEmailOpenTracking } from "../src/messaging/openTracking";

export interface TrackingNewsletterFixture {
  publisherId: string;
  workspaceId: string;
  accountId: string;
  connectionId: string;
  hostname: string;
}

export interface TrackedSendFixture {
  sendId: string;
  userId: string;
  messageId: string;
  token: string;
  path: string;
  html: string;
}

/** Disposable database rows only: no provider calls or sending permissions. */
export async function createTrackingNewsletterFixture(): Promise<TrackingNewsletterFixture> {
  const publisherId = randomUUID();
  const workspaceId = randomUUID();
  const accountId = randomUUID();
  const connectionId = randomUUID();
  const domain = `${randomUUID()}.example`;
  const hostname = `dt.${domain}`;
  await db().insert(workspace).values([
    { id: publisherId, name: `Tracking fixture ${publisherId}`, type: "Parent" },
    { id: workspaceId, name: `Tracking fixture newsletter ${workspaceId}`, type: "Child", parentWorkspaceId: publisherId },
  ]);
  await db().insert(publisher).values({ workspaceId: publisherId });
  await db().insert(newsletter).values({ workspaceId, publisherId, slug: randomUUID() });
  await db().insert(publisherSendgridAccount).values({ id: accountId, publisherId, name: "Tracking fixture ESP" });
  await db().insert(sendingConnection).values({
    id: connectionId, publisherId, accountId,
    username: `fixture-${randomUUID()}`, administrativeEmail: "fixture@example.invalid",
  });
  await db().insert(newsletterTrackingDomain).values({
    newsletterId: workspaceId, domain, hostname, status: "active",
    cnameVerified: true, cloudflareStatus: "active", sslStatus: "active", verifiedAt: new Date(),
  });
  return { publisherId, workspaceId, accountId, connectionId, hostname };
}

/** Creates a canonical send without submitting mail or invoking a provider adapter. */
export async function createTrackedSendFixture(
  fixture: TrackingNewsletterFixture,
  input: { userId?: string; messageId?: string } = {},
): Promise<TrackedSendFixture> {
  const sendId = randomUUID();
  const userId = input.userId ?? randomUUID();
  const messageId = input.messageId ?? randomUUID();
  const tracking = await prepareEmailOpenTracking({
    sendId, workspaceId: fixture.workspaceId, html: "<p>Inbound fixture only; never sent.</p>",
  });
  await db().insert(newsletterSend).values({
    id: sendId, publisherId: fixture.publisherId, workspaceId: fixture.workspaceId,
    accountId: fixture.accountId, accountRevision: 1,
    connectionId: fixture.connectionId, connectionRevision: 1,
    selection: { accountId: fixture.accountId, mode: "automatic" }, candidateIpIds: [],
    logicalMessageId: messageId, userId, mailboxHash: "fixture", payloadHash: "fixture",
    openTrackingTokenHash: tracking.openTrackingTokenHash,
    encryptedOpenTrackingToken: tracking.encryptedOpenTrackingToken,
    openTrackingOrigin: tracking.openTrackingOrigin,
  });
  const match = /\/api\/public\/email\/open\/([A-Za-z0-9_-]{43})\.gif/.exec(tracking.html);
  if (!match?.[0] || !match[1]) throw new Error("Tracking fixture pixel missing");
  return { sendId, userId, messageId, token: match[1], path: match[0], html: tracking.html };
}
