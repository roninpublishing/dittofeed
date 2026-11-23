import { v4 as uuid } from "uuid";

import { query } from "../clickhouse";
import { BatchAppData, EventType, InternalEventType } from "../types";
import { findUserEvents } from "../userEvents";
import { buildBatchUserEvents, submitBatch } from "./batch";

let testWorkspaceId: string;

describe("batch", () => {
  describe("batch context merging", () => {
    beforeEach(() => {
      testWorkspaceId = uuid();
    });
    describe("buildBatchUserEvents", () => {
      it("should merge batch context with individual event context, with event context overriding", () => {
        const batchData = {
          context: {
            ip: "192.168.1.1",
            userAgent: "batch-agent",
            source: "batch",
          },
          batch: [
            {
              type: EventType.Track as const,
              event: "Test Event",
              userId: "user1",
              messageId: uuid(),
              properties: {
                test: "value",
              },
              context: {
                ip: "10.0.0.1", // Should override batch IP
                sessionId: "session123", // Should be added to merged context
              },
            },
            {
              type: EventType.Identify as const,
              userId: "user2",
              messageId: uuid(),
              traits: {
                email: "test@example.com",
              },
              context: {
                userAgent: "event-agent", // Should override batch userAgent
              },
            },
            {
              type: EventType.Track as const,
              event: "Another Event",
              userId: "user3",
              messageId: uuid(),
              properties: {
                another: "property",
              },
              // No individual context - should use batch context only
            },
          ],
        };

        const userEvents = buildBatchUserEvents(batchData);

        expect(userEvents).toHaveLength(3);

        // First event: context should be merged with event context overriding
        const firstEvent = userEvents[0];
        if (!firstEvent) {
          throw new Error("Expected first event to exist");
        }
        const firstMessageRaw = firstEvent.messageRaw;
        if (typeof firstMessageRaw === "string") {
          const firstEventRaw = JSON.parse(firstMessageRaw);
          expect(firstEventRaw.context).toEqual({
            ip: "10.0.0.1", // Overridden
            userAgent: "batch-agent", // From batch
            source: "batch", // From batch
            sessionId: "session123", // Added from event
          });
          expect(firstEventRaw.properties).toEqual({ test: "value" });
        } else {
          throw new Error("Expected messageRaw to be a string");
        }

        // Second event: context should be merged with event context overriding
        const secondEvent = userEvents[1];
        if (!secondEvent) {
          throw new Error("Expected second event to exist");
        }
        const secondMessageRaw = secondEvent.messageRaw;
        if (typeof secondMessageRaw === "string") {
          const secondEventRaw = JSON.parse(secondMessageRaw);
          expect(secondEventRaw.context).toEqual({
            ip: "192.168.1.1", // From batch (not overridden)
            userAgent: "event-agent", // Overridden
            source: "batch", // From batch
          });
          expect(secondEventRaw.traits).toEqual({ email: "test@example.com" });
        } else {
          throw new Error("Expected messageRaw to be a string");
        }

        // Third event: should use batch context only
        const thirdEvent = userEvents[2];
        if (!thirdEvent) {
          throw new Error("Expected third event to exist");
        }
        const thirdMessageRaw = thirdEvent.messageRaw;
        if (typeof thirdMessageRaw === "string") {
          const thirdEventRaw = JSON.parse(thirdMessageRaw);
          expect(thirdEventRaw.context).toEqual({
            ip: "192.168.1.1",
            userAgent: "batch-agent",
            source: "batch",
          });
          expect(thirdEventRaw.properties).toEqual({ another: "property" });
        } else {
          throw new Error("Expected messageRaw to be a string");
        }
      });

      it("should handle empty batch context", () => {
        const batchData = {
          batch: [
            {
              type: EventType.Track as const,
              event: "Test Event",
              userId: "user1",
              messageId: uuid(),
              context: {
                sessionId: "session123",
              },
            },
          ],
        };

        const userEvents = buildBatchUserEvents(batchData);
        const firstEvent = userEvents[0];
        if (!firstEvent) {
          throw new Error("Expected first event to exist");
        }
        const messageRaw = firstEvent.messageRaw;

        if (typeof messageRaw === "string") {
          const eventRaw = JSON.parse(messageRaw);
          expect(eventRaw.context).toEqual({
            sessionId: "session123",
          });
        } else {
          throw new Error("Expected messageRaw to be a string");
        }
      });

      it("should handle empty event context", () => {
        const batchData = {
          context: {
            ip: "192.168.1.1",
          },
          batch: [
            {
              type: EventType.Track as const,
              event: "Test Event",
              userId: "user1",
              messageId: uuid(),
            },
          ],
        };

        const userEvents = buildBatchUserEvents(batchData);
        const firstEvent = userEvents[0];
        if (!firstEvent) {
          throw new Error("Expected first event to exist");
        }
        const messageRaw = firstEvent.messageRaw;

        if (typeof messageRaw === "string") {
          const eventRaw = JSON.parse(messageRaw);
          expect(eventRaw.context).toEqual({
            ip: "192.168.1.1",
          });
        } else {
          throw new Error("Expected messageRaw to be a string");
        }
      });

      it("should handle both context being undefined", () => {
        const batchData = {
          batch: [
            {
              type: EventType.Track as const,
              event: "Test Event",
              userId: "user1",
              messageId: uuid(),
            },
          ],
        };

        const userEvents = buildBatchUserEvents(batchData);
        const firstEvent = userEvents[0];
        if (!firstEvent) {
          throw new Error("Expected first event to exist");
        }
        const messageRaw = firstEvent.messageRaw;

        if (typeof messageRaw === "string") {
          const eventRaw = JSON.parse(messageRaw);
          expect(eventRaw.context).toEqual({});
        } else {
          throw new Error("Expected messageRaw to be a string");
        }
      });
    });

    describe("click event-time normalization", () => {
      it("overrides a caller clickedAt without losing provider/source evidence or send identity", () => {
        const timestamp = "2026-11-20T07:23:45.123-05:00";
        const properties = {
          clickedAt: "2099-01-01T00:00:00Z", messageId: "internal-send",
          url: "https://example.com/article", providerMessageId: "provider-send",
          providerEventId: "provider-click", evidenceSource: "telnyx_webhook",
          engagementClassification: "human",
        };
        const data: BatchAppData = {
          context: { source: "webhook", provider: "Telnyx" },
          batch: [{
            type: EventType.Track, event: InternalEventType.EmailClicked,
            userId: "contact", messageId: "stable-click-id", timestamp, properties,
          }],
        };
        const first = buildBatchUserEvents(data, { processingTime: Date.parse("2026-11-21T00:00:00Z") })[0];
        const retry = buildBatchUserEvents(data, { processingTime: Date.parse("2026-11-22T00:00:00Z") })[0];
        expect(first?.messageId).toBe("stable-click-id");
        expect(retry?.messageRaw).toEqual(first?.messageRaw);
        expect(JSON.parse(String(first?.messageRaw))).toMatchObject({
          timestamp, context: data.context,
          properties: {
            ...properties, clickedAt: "2026-11-20T12:23:45.123Z",
            engagementClassification: "observed_unqualified",
          },
        });
        expect(properties.clickedAt).toBe("2099-01-01T00:00:00Z");
      });

      it("normalizes direct clicks with omitted properties and leaves non-click events alone", () => {
        const timestamp = "2026-11-20T12:23:45.123Z";
        const events = buildBatchUserEvents({ batch: [
          { type: EventType.Track, event: InternalEventType.EmailClicked, userId: "contact", messageId: "click", timestamp },
          { type: EventType.Track, event: "ArticleClicked", userId: "contact", messageId: "custom", timestamp, properties: { clickedAt: "custom" } },
          { type: EventType.Identify, userId: "contact", messageId: "identify", timestamp, traits: { email: "contact@example.com" } },
        ] });
        expect(JSON.parse(String(events[0]?.messageRaw)).properties).toEqual({
          clickedAt: timestamp, evidenceSource: "native_ingestion", engagementClassification: "observed_unqualified",
        });
        expect(JSON.parse(String(events[1]?.messageRaw)).properties).toEqual({ clickedAt: "custom" });
        expect(JSON.parse(String(events[2]?.messageRaw))).toMatchObject({ traits: { email: "contact@example.com" } });
        expect(JSON.parse(String(events[2]?.messageRaw))).not.toHaveProperty("properties");
      });

      it("keeps open occurrence time and identity stable across processing retries", () => {
        const properties = {
          messageId: "internal-send", openedAt: "2099-01-01T00:00:00Z",
          providerEventId: "provider-open", evidenceSource: "telnyx_webhook",
          engagementClassification: "human",
        };
        const data: BatchAppData = { batch: [{
          type: EventType.Track, event: InternalEventType.EmailOpened,
          userId: "contact", messageId: "stable-open-id",
          timestamp: "2026-11-20T14:23:45.123+02:00", properties,
        }] };
        const first = buildBatchUserEvents(data, { processingTime: 1795200000000 })[0];
        const retry = buildBatchUserEvents(data, { processingTime: 1795300000000 })[0];
        expect(retry?.messageRaw).toEqual(first?.messageRaw);
        expect(JSON.parse(String(first?.messageRaw))).toMatchObject({
          messageId: "stable-open-id",
          properties: {
            ...properties, openedAt: "2026-11-20T12:23:45.123Z",
            engagementClassification: "observed_unqualified",
          },
        });
        expect(properties.openedAt).toBe("2099-01-01T00:00:00Z");
      });
    });

    describe("submitBatch", () => {
      it("should submit events with merged context and be retrievable", async () => {
        const messageId1 = uuid();
        const messageId2 = uuid();

        const batchData = {
          context: {
            ip: "192.168.1.1",
            source: "test-batch",
          },
          batch: [
            {
              type: EventType.Track as const,
              event: "Context Test Event 1",
              userId: "test-user-1",
              messageId: messageId1,
              properties: {
                testProp: "value1",
              },
              context: {
                sessionId: "session-abc",
                ip: "10.0.0.1", // Should override batch IP
              },
            },
            {
              type: EventType.Track as const,
              event: "Context Test Event 2",
              userId: "test-user-2",
              messageId: messageId2,
              properties: {
                testProp: "value2",
              },
              // No individual context - should use batch context
            },
          ],
        };

        await submitBatch({
          workspaceId: testWorkspaceId,
          data: batchData,
        });

        // Retrieve the events to verify context was merged correctly
        const events = await findUserEvents({
          workspaceId: testWorkspaceId,
          messageId: [messageId1, messageId2],
          includeContext: true,
        });

        expect(events).toHaveLength(2);

        // Find events by message ID for reliable testing
        const event1 = events.find((e) => e.message_id === messageId1);
        const event2 = events.find((e) => e.message_id === messageId2);

        expect(event1).toBeDefined();
        expect(event2).toBeDefined();

        if (event1 && event1.context) {
          const context1 = JSON.parse(event1.context);
          expect(context1).toEqual({
            ip: "10.0.0.1", // Overridden value
            source: "test-batch", // From batch
            sessionId: "session-abc", // From event
          });
        }

        if (event2 && event2.context) {
          const context2 = JSON.parse(event2.context);
          expect(context2).toEqual({
            ip: "192.168.1.1", // From batch
            source: "test-batch", // From batch
          });
        }
      });
    });

    describe("server_timestamp verification", () => {
      it("should set server_timestamp columns to current time when writing batch data", async () => {
        // Memorize current timestamp before batch submission
        const beforeTimestamp = Date.now();

        const messageId1 = uuid();
        const messageId2 = uuid();

        const batchData = {
          context: {
            source: "server-timestamp-test",
          },
          batch: [
            {
              type: EventType.Track as const,
              event: "Server Timestamp Test Event 1",
              userId: "test-user-1",
              messageId: messageId1,
              properties: {
                testProp: "value1",
              },
            },
            {
              type: EventType.Identify as const,
              userId: "test-user-2",
              messageId: messageId2,
              traits: {
                email: "test2@example.com",
              },
            },
          ],
        };

        await submitBatch({
          workspaceId: testWorkspaceId,
          data: batchData,
        });

        // Query user_events_v2 table directly using ClickHouse query method
        const result = await query({
          query: `
            SELECT message_id, server_time
            FROM user_events_v2
            WHERE workspace_id = {workspaceId:String}
              AND message_id IN ({messageId1:String}, {messageId2:String})
            ORDER BY message_id
          `,
          query_params: {
            workspaceId: testWorkspaceId,
            messageId1,
            messageId2,
          },
        });

        const rows = await result.json();
        expect(rows).toHaveLength(2);

        // Verify that server_timestamp columns exceed the memorized timestamp
        for (const row of rows) {
          const rowData = row as { message_id: string; server_time: string };

          // ClickHouse returns timestamps in format "YYYY-MM-DD HH:mm:ss.SSS" which needs to be treated as UTC
          const serverTimestamp = new Date(`${rowData.server_time}Z`).getTime();

          expect(serverTimestamp).toBeGreaterThanOrEqual(beforeTimestamp);

          // Also verify it's not too far in the future (within 10 seconds)
          const afterTimestamp = Date.now();
          expect(serverTimestamp).toBeLessThanOrEqual(afterTimestamp + 10000);
        }
      });
    });
  });
});
