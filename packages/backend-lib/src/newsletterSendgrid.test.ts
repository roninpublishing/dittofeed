import axios from "axios";

import {
  NewsletterInfrastructureError,
  NewsletterSendgridClient,
  NEWSLETTER_WEBHOOK_EVENTS,
  webhookIsReady,
} from "./newsletterSendgrid";

describe("SendGrid management boundary", () => {
  afterEach(() => jest.restoreAllMocks());

  it("fails every provider write with gates closed without reaching transport", async () => {
    const transport = jest.spyOn(axios, "request");
    const client = new NewsletterSendgridClient({
      apiKey: "fixture-private-key",
      region: "global",
      allowProviderWrites: false,
      allowIpReassignment: false,
    });
    for (const method of ["POST", "PUT", "PATCH"] as const)
      await expect(
        client.request(method, "/subusers", { password: "fixture-password" }),
      ).rejects.toThrow("provider_writes_disabled");
    expect(transport).not.toHaveBeenCalled();
  });

  it("requires the independent IP assignment gate even with ordinary writes enabled", async () => {
    const transport = jest.spyOn(axios, "request");
    const client = new NewsletterSendgridClient({
      apiKey: "fixture-private-key",
      region: "global",
      allowProviderWrites: true,
      allowIpReassignment: false,
    });
    await expect(
      client.request(
        "PUT",
        "/subusers/fixture/ips",
        ["192.0.2.10"],
        undefined,
        true,
      ),
    ).rejects.toThrow("ip_reassignment_disabled");
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not expose provider errors, request data or credentials", async () => {
    jest
      .spyOn(axios, "request")
      .mockRejectedValue({
        isAxiosError: true,
        response: { status: 403, data: { error: "fixture-provider-secret" } },
        config: {
          headers: { Authorization: "Bearer fixture-private-key" },
          data: "fixture-password",
        },
      });
    const client = new NewsletterSendgridClient({
      apiKey: "fixture-private-key",
      region: "global",
      allowProviderWrites: true,
      allowIpReassignment: false,
    });
    try {
      await client.request("POST", "/subusers", {
        password: "fixture-password",
      });
      throw new Error("Expected sanitized failure");
    } catch (error) {
      expect(error).toBeInstanceOf(NewsletterInfrastructureError);
      expect(JSON.stringify(error)).not.toMatch(/fixture-/);
      expect(String(error)).toBe(
        "NewsletterInfrastructureError: sendgrid_management_request_failed",
      );
    }
  });

  it("uses parent credentials with scoped subuser header and disables redirects", async () => {
    const transport = jest
      .spyOn(axios, "request")
      .mockResolvedValue({ data: { result: [] } });
    const client = new NewsletterSendgridClient({
      apiKey: "fixture-management-key",
      region: "eu",
      allowProviderWrites: false,
      allowIpReassignment: false,
    });
    await client.apiKeys("fixture-ditto");
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.eu.sendgrid.com/v3/api_keys",
        method: "GET",
        maxRedirects: 0,
        headers: {
          Authorization: "Bearer fixture-management-key",
          "on-behalf-of": "fixture-ditto",
        },
      }),
    );
  });

  it("uses the registered parent account identity without inventing an on-behalf-of username", async () => {
    const transport = jest.spyOn(axios, "request").mockResolvedValue({ data: { result: [] } });
    const client = new NewsletterSendgridClient({
      apiKey: "fixture-parent-management-key", region: "global",
      allowProviderWrites: false, allowIpReassignment: false,
    });
    await client.apiKeys("");
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({
      headers: { Authorization: "Bearer fixture-parent-management-key" },
    }));
  });

  it("requires an enabled signed callback at the exact connection URL with all required events", () => {
    const url =
      "https://callbacks.example.com/api/public/webhooks/sendgrid/connections/fixture";
    const webhook = {
      id: "fixture",
      url,
      enabled: true,
      public_key: "verification-public-key",
      ...Object.fromEntries(
        NEWSLETTER_WEBHOOK_EVENTS.map((event) => [event, true]),
      ),
    };
    expect(webhookIsReady(webhook, url)).toBe(true);
    expect(webhookIsReady({ ...webhook, public_key: undefined }, url)).toBe(
      false,
    );
    expect(webhookIsReady({ ...webhook, enabled: false }, url)).toBe(false);
    expect(webhookIsReady({ ...webhook, spam_report: false }, url)).toBe(false);
    expect(webhookIsReady(webhook, `${url}-other`)).toBe(false);
  });
});
