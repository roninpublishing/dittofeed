import axios from "axios";

export class NewsletterTrackingError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string) {
    super(code);
    this.name = "NewsletterTrackingError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface TrackingCustomHostname {
  id: string;
  hostname: string;
  status?: string;
  ssl?: { status?: string; validation_records?: { txt_name?: string; txt_value?: string }[] };
  ownership_verification?: { type?: string; name?: string; value?: string };
}

/** Fixed API origin, no redirects, no email validation, no raw provider errors. */
export class NewsletterTrackingCloudflareClient {
  constructor(private readonly settings: { token: string; zoneId: string; allowProvisioning: boolean }) {}

  async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    if (method !== "GET" && !this.settings.allowProvisioning) {
      throw new NewsletterTrackingError(409, "tracking_provisioning_disabled");
    }
    if (!/^[a-f0-9]{32}$/i.test(this.settings.zoneId) || !/^\/custom_hostnames(?:[/?]|$)/.test(path)) {
      throw new NewsletterTrackingError(409, "tracking_provider_not_configured");
    }
    try {
      const response = await axios.request<{ success: boolean; result: T }>({
        method, url: `https://api.cloudflare.com/client/v4/zones/${this.settings.zoneId}${path}`,
        headers: { Authorization: `Bearer ${this.settings.token}` }, data: body,
        timeout: 15_000, maxRedirects: 0, maxContentLength: 256 * 1024,
      });
      if (response.data.success !== true) throw new Error();
      return response.data.result;
    } catch {
      throw new NewsletterTrackingError(502, "tracking_provider_failed");
    }
  }

  async find(hostname: string): Promise<TrackingCustomHostname | null> {
    const rows = await this.request<TrackingCustomHostname[]>("GET", `/custom_hostnames?hostname=${encodeURIComponent(hostname)}&per_page=50`);
    if (!Array.isArray(rows)) throw new NewsletterTrackingError(502, "tracking_provider_failed");
    const matches = rows.filter((row) => row?.hostname?.toLowerCase() === hostname);
    if (matches.length > 1 || (matches[0] && !/^[a-f0-9-]{32,36}$/i.test(matches[0].id))) {
      throw new NewsletterTrackingError(502, "tracking_provider_failed");
    }
    return matches[0] ?? null;
  }

  async create(hostname: string): Promise<TrackingCustomHostname> {
    const row = await this.request<TrackingCustomHostname>("POST", "/custom_hostnames", {
      hostname, ssl: { method: "txt", type: "dv" },
    });
    if (row?.hostname !== hostname || !/^[a-f0-9-]{32,36}$/i.test(row.id)) {
      throw new NewsletterTrackingError(502, "tracking_provider_failed");
    }
    return row;
  }
}
