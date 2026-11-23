import { insertUserEvents } from "../userEvents";
import { InternalEventType, TrackData } from "../types";
import { submitTrack } from "./track";

jest.mock("../userEvents", () => ({ insertUserEvents: jest.fn() }));
const insert = jest.mocked(insertUserEvents);

function fixture(): TrackData {
  return {
    messageId: "stable-click-id", userId: "contact", event: InternalEventType.EmailClicked,
    timestamp: "2026-11-20T14:23:45.123+02:00",
    properties: {
      messageId: "internal-send", clickedAt: "2099-01-01T00:00:00Z", url: "https://example.com/link",
      engagementClassification: "human", providerMessageId: "provider-send", providerEventId: "provider-click",
    },
    context: { client: "native-sdk" },
  };
}

describe("native track click observations", () => {
  beforeEach(() => { jest.clearAllMocks(); insert.mockResolvedValue(undefined); });

  it("derives clickedAt from event time and keeps stable retry/send identity without claiming human verification", async () => {
    const data = fixture();
    await submitTrack({ workspaceId: "workspace", data });
    await submitTrack({ workspaceId: "workspace", data });
    expect(insert.mock.calls[1]).toEqual(insert.mock.calls[0]);
    const submitted = insert.mock.calls[0]?.[0].userEvents?.[0];
    expect(submitted?.messageId).toBe("stable-click-id");
    expect(JSON.parse(String(submitted?.messageRaw))).toMatchObject({
      timestamp: data.timestamp, context: data.context,
      properties: {
        messageId: "internal-send", clickedAt: "2026-11-20T12:23:45.123Z", url: "https://example.com/link",
        providerMessageId: "provider-send", providerEventId: "provider-click",
        evidenceSource: "native_ingestion", engagementClassification: "observed_unqualified",
      },
    });
    expect(data.properties?.clickedAt).toBe("2099-01-01T00:00:00Z");
  });

  it("uses the same single timestamp when the caller omits event time", async () => {
    await submitTrack({ workspaceId: "workspace", data: { ...fixture(), timestamp: undefined } });
    const submitted = insert.mock.calls[0]?.[0].userEvents?.[0];
    const raw = JSON.parse(String(submitted?.messageRaw));
    expect(raw.properties.clickedAt).toBe(raw.timestamp);
  });

  it("records native opens at event time without accepting a claimed human classification", async () => {
    const data: TrackData = {
      ...fixture(),
      event: InternalEventType.EmailOpened,
      messageId: "stable-open-id",
      properties: {
        messageId: "internal-send",
        openedAt: "2099-01-01T00:00:00Z",
        engagementClassification: "human",
        evidenceId: "request-evidence",
      },
    };
    await submitTrack({ workspaceId: "workspace", data });
    await submitTrack({ workspaceId: "workspace", data });
    expect(insert.mock.calls[1]).toEqual(insert.mock.calls[0]);
    const submitted = insert.mock.calls[0]?.[0].userEvents?.[0];
    expect(JSON.parse(String(submitted?.messageRaw))).toMatchObject({
      messageId: "stable-open-id",
      properties: {
        messageId: "internal-send", openedAt: "2026-11-20T12:23:45.123Z",
        evidenceId: "request-evidence", evidenceSource: "native_ingestion",
        engagementClassification: "observed_unqualified",
      },
    });
    expect(data.properties?.openedAt).toBe("2099-01-01T00:00:00Z");
  });

  it("does not reinterpret custom event properties", async () => {
    const data = { ...fixture(), event: "ArticleClicked" };
    await submitTrack({ workspaceId: "workspace", data });
    const submitted = insert.mock.calls[0]?.[0].userEvents?.[0];
    expect(JSON.parse(String(submitted?.messageRaw)).properties).toEqual(data.properties);
  });
});
