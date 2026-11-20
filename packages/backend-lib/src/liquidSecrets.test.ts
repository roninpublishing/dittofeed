import { randomUUID } from "crypto";
import { SecretNames } from "isomorphic-lib/src/constants";

import { renderLiquid } from "./liquid";
import { generateSubscriptionChangeUrl } from "./subscriptionGroups";
import { SubscriptionChange } from "./types";

describe("private Liquid subscription signing material", () => {
  const workspaceId = randomUUID();
  const subscriptionGroupId = randomUUID();
  const subscriptionSecret = "master-signing-secret-must-not-be-rendered";
  const userId = "subscription-test-user";
  const email = "recipient@example.com";
  const options = {
    workspaceId,
    subscriptionGroupId,
    identifierKey: "email",
    secrets: {
      [SecretNames.Subscription]: subscriptionSecret,
      webhook_token: "intentional-webhook-template-value",
    },
    userProperties: { id: userId, email },
  };

  it("does not expose the master signing secret to arbitrary template expressions", () => {
    const rendered = renderLiquid({
      ...options,
      template: "{% for entry in secrets %}{{ entry[0] }}={{ entry[1] }};{% endfor %}",
    });
    expect(rendered).not.toContain(subscriptionSecret);
    expect(rendered).not.toContain(SecretNames.Subscription);
    expect(rendered).toContain("webhook_token=intentional-webhook-template-value;");
    expect(() => renderLiquid({
      ...options,
      template: `{{ secrets['${SecretNames.Subscription}'] }}`,
    })).toThrow();
  });

  it("preserves recipient-specific unsubscribe and management URLs", () => {
    const unsubscribe = generateSubscriptionChangeUrl({
      workspaceId,
      changedSubscription: subscriptionGroupId,
      identifier: email,
      identifierKey: "email",
      subscriptionSecret,
      userId,
      subscriptionChange: SubscriptionChange.Unsubscribe,
    });
    const management = generateSubscriptionChangeUrl({
      workspaceId,
      identifier: email,
      identifierKey: "email",
      subscriptionSecret,
      userId,
      showAllChannels: true,
    });
    expect(renderLiquid({ ...options, template: "{% unsubscribe_url %}" })).toBe(unsubscribe);
    expect(renderLiquid({ ...options, template: "{% subscription_management_url %}" })).toBe(management);
    const links = renderLiquid({
      ...options,
      template: "{% unsubscribe_link %} {% subscription_management_link %}",
    });
    expect(links).toContain(unsubscribe);
    expect(links).toContain(management);
    expect(links).not.toContain(subscriptionSecret);
    const layout = renderLiquid({
      ...options,
      template: "{% layout 'base-email' %}{% block content %}{% for entry in secrets %}{{ entry[1] }}{% endfor %}{% unsubscribe_url %}{% endblock %}",
    });
    expect(layout).toContain("<!DOCTYPE html>");
    expect(layout).toContain(unsubscribe);
    expect(layout).not.toContain(subscriptionSecret);
  });

  it("cannot replace private signing material by assigning public Liquid variables", () => {
    const rendered = renderLiquid({
      ...options,
      template: "{% assign secrets = user %}{% unsubscribe_url %}",
    });
    expect(rendered).toBe(renderLiquid({ ...options, template: "{% unsubscribe_url %}" }));
    expect(rendered).not.toContain(subscriptionSecret);
  });

  it("isolates signing material between renders", () => {
    const first = renderLiquid({ ...options, template: "{% unsubscribe_url %}" });
    const second = renderLiquid({
      ...options,
      secrets: { [SecretNames.Subscription]: "another-master-secret" },
      template: "{% unsubscribe_url %}",
    });
    expect(first).not.toBe(second);
    expect(renderLiquid({ ...options, template: "{% unsubscribe_url %}" })).toBe(first);
  });
});
