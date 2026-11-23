import axios from "axios";

import { NewsletterTrackingCloudflareClient } from "./newsletterTrackingCloudflare";

const hostname = "dt.newsletter.example";
const settings = { token: "fixture-sensitive-token", zoneId: "a".repeat(32), allowProvisioning: false };
afterEach(() => jest.restoreAllMocks());

describe("Cloudflare tracking transport", () => {
  it("keeps creation default-closed before any HTTP request", async () => {
    const http = jest.spyOn(axios, "request").mockRejectedValue(new Error("unexpected network"));
    await expect(new NewsletterTrackingCloudflareClient(settings).create(hostname)).rejects.toMatchObject({ code: "tracking_provisioning_disabled" });
    expect(http).not.toHaveBeenCalled();
  });

  it("creates only TXT DV validation at the fixed provider origin with redirects disabled", async () => {
    const row = { id: "b".repeat(32), hostname, status: "pending" };
    const http = jest.spyOn(axios, "request").mockResolvedValue({ data: { success: true, result: row } });
    expect(await new NewsletterTrackingCloudflareClient({ ...settings, allowProvisioning: true }).create(hostname)).toEqual(row);
    expect(http).toHaveBeenCalledWith(expect.objectContaining({ method: "POST", url: `https://api.cloudflare.com/client/v4/zones/${settings.zoneId}/custom_hostnames`,
      data: { hostname, ssl: { method: "txt", type: "dv" } }, maxRedirects: 0, timeout: 15000 }));
  });

  it("adopts only an exact hostname match and rejects ambiguous matches", async () => {
    const http = jest.spyOn(axios, "request").mockResolvedValue({ data: { success: true, result: [{ id: "b".repeat(32), hostname: "dt.other.example" }] } });
    const client = new NewsletterTrackingCloudflareClient(settings);
    expect(await client.find(hostname)).toBeNull();
    http.mockResolvedValue({ data: { success: true, result: [{ id: "b".repeat(32), hostname }, { id: "c".repeat(32), hostname }] } });
    await expect(client.find(hostname)).rejects.toMatchObject({ code: "tracking_provider_failed" });
  });

  it("never propagates provider error credentials, bodies, validation errors, or request headers", async () => {
    jest.spyOn(axios, "request").mockRejectedValue({ message: settings.token, config: { headers: { Authorization: `Bearer ${settings.token}` } }, response: { data: { errors: [{ message: "sensitive upstream detail" }] } } });
    const client = new NewsletterTrackingCloudflareClient(settings);
    await expect(client.find(hostname)).rejects.toMatchObject({ statusCode: 502, code: "tracking_provider_failed", message: "tracking_provider_failed" });
    try { await client.find(hostname); } catch (error) {
      expect(JSON.stringify(error)).not.toContain(settings.token);
      expect(JSON.stringify(error)).not.toContain("sensitive upstream detail");
    }
  });
});
