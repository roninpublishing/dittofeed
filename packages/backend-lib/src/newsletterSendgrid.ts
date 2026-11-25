import axios from "axios";

export class NewsletterInfrastructureError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(code);
    this.name = "NewsletterInfrastructureError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface SendgridSubuser {
  username: string;
  email: string;
  disabled: boolean;
  region?: string;
}
export interface SendgridApiKey {
  api_key_id: string;
  name: string;
  scopes?: string[];
  api_key?: string;
}
export interface SendgridDomain {
  id: number;
  domain: string;
  subdomain: string;
  username: string;
  valid: boolean;
  dns?: Record<
    string,
    { type: string; host: string; data: string; valid: boolean }
  >;
  subusers?: { username: string }[];
}
export interface SendgridSender {
  id: number;
  from_email: string;
  verified: boolean;
}
export interface SendgridWebhook {
  id: string;
  url: string;
  enabled: boolean;
  public_key?: string;
  [event: string]: string | boolean | undefined;
}
export interface SendgridIp {
  ip: string;
  subusers: string[];
  pools: string[];
  whitelabeled: boolean;
}
/** SendGrid selects named pools, not raw IP addresses. IP mode uses a verified singleton pool. */
export const SENDGRID_SELECTION_CAPABILITIES = {
  automatic: true, pool: true, ip: true, multiIp: true, rawIp: false,
} as const;
export const NEWSLETTER_WEBHOOK_EVENTS = [
  "delivered",
  "bounce",
  "deferred",
  "dropped",
  "processed",
  "open",
  "click",
  "spam_report",
  "unsubscribe",
  "group_unsubscribe",
  "group_resubscribe",
] as const;

// Endpoint contracts: Twilio SendGrid API reference, subusers-api, api-keys,
// domain-authentication, webhooks, ip-address and ip-pools (2026-11).
// Never return Axios errors: they include the Authorization header and body.
export class NewsletterSendgridClient {
  constructor(
    private readonly account: {
      apiKey: string;
      region: string;
      allowProviderWrites: boolean;
      allowIpReassignment: boolean;
    },
  ) {}

  async request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH",
    path: string,
    body?: unknown,
    username?: string,
    ipAssignment = false,
  ): Promise<T> {
    if (method !== "GET" && !this.account.allowProviderWrites) {
      throw new NewsletterInfrastructureError(409, "provider_writes_disabled");
    }
    if (ipAssignment && !this.account.allowIpReassignment) {
      throw new NewsletterInfrastructureError(409, "ip_reassignment_disabled");
    }
    try {
      const result = await axios.request<T>({
        method,
        url: `${this.account.region === "eu" ? "https://api.eu.sendgrid.com" : "https://api.sendgrid.com"}/v3${path}`,
        headers: {
          Authorization: `Bearer ${this.account.apiKey}`,
          ...(username ? { "on-behalf-of": username } : {}),
        },
        data: body,
        timeout: 20_000,
        maxRedirects: 0,
      });
      return result.data;
    } catch (error) {
      const status = axios.isAxiosError(error)
        ? error.response?.status
        : undefined;
      throw new NewsletterInfrastructureError(
        status === 404 ? 404 : 502,
        status === 404
          ? "provider_resource_not_found"
          : "sendgrid_management_request_failed",
      );
    }
  }

  async list<T>(path: string, username?: string): Promise<T[]> {
    const rows: T[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await this.request<T[]>(
        "GET",
        `${path}${path.includes("?") ? "&" : "?"}limit=100&offset=${offset}`,
        undefined,
        username,
      );
      if (!Array.isArray(page))
        throw new NewsletterInfrastructureError(
          502,
          "invalid_provider_response",
        );
      rows.push(...page);
      if (page.length < 100) return rows;
    }
  }

  async subuser(username: string) {
    const rows = await this.list<SendgridSubuser>(
      `/subusers?username=${encodeURIComponent(username)}&include_region=true`,
    );
    return rows.find((row) => row.username === username) ?? null;
  }
  async identityUsername(username: string) {
    if (username) return username;
    const identity = await this.request<{ username: string }>("GET", "/user/username");
    if (typeof identity.username !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(identity.username))
      throw new NewsletterInfrastructureError(502, "invalid_provider_identity");
    return identity.username;
  }

  async apiKeys(username: string) {
    const result = await this.request<{ result: SendgridApiKey[] }>(
      "GET",
      "/api_keys",
      undefined,
      username,
    );
    if (!Array.isArray(result.result))
      throw new NewsletterInfrastructureError(502, "invalid_provider_response");
    return result.result;
  }

  async senders(username: string) {
    const senders: SendgridSender[] = [];
    let lastSeenId = 0;
    for (;;) {
      const response = await this.request<{ results: SendgridSender[] }>(
        "GET",
        `/verified_senders?limit=100&lastSeenID=${lastSeenId}`,
        undefined,
        username,
      );
      if (!Array.isArray(response.results))
        throw new NewsletterInfrastructureError(
          502,
          "invalid_provider_response",
        );
      senders.push(...response.results);
      if (response.results.length < 100) return senders;
      const nextId = Math.max(...response.results.map((sender) => sender.id));
      if (nextId <= lastSeenId)
        throw new NewsletterInfrastructureError(
          502,
          "invalid_provider_pagination",
        );
      lastSeenId = nextId;
    }
  }

  async pool(name: string, username: string) {
    try {
      return await this.request<{ pool_name: string; ips: string[] }>(
        "GET",
        `/ips/pools/${encodeURIComponent(name)}`,
        undefined,
        username,
      );
    } catch (error) {
      if (
        error instanceof NewsletterInfrastructureError &&
        error.statusCode === 404
      )
        return null;
      throw error;
    }
  }
}


export function webhookIsReady(
  webhook: SendgridWebhook | undefined,
  expectedUrl: string,
) {
  return (
    !!webhook &&
    webhook.url === expectedUrl &&
    webhook.enabled === true &&
    typeof webhook.public_key === "string" &&
    webhook.public_key.length > 0 &&
    NEWSLETTER_WEBHOOK_EVENTS.every((event) => webhook[event] === true)
  );
}
