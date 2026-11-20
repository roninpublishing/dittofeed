import { RoleEnum } from "isomorphic-lib/src/types";

import {
  accountErrorMessage,
  authErrorMessage,
  manageableAccountRoles,
  takeInvitationToken,
} from "./accountUi";

function invitationBrowser(hash: string) {
  const location = {
    hash,
    pathname: "/dashboard/auth/invite",
    search: "?view=invitation",
  };
  const state = { nextRouter: true };
  const history = {
    state,
    replaceState: jest.fn((_state: unknown, _title: string, url: string) => {
      location.hash = new URL(url, "https://mail.example.com").hash;
    }),
  };
  return { location, history, state };
}

describe("private invitation handoff", () => {
  it("takes the fragment once and replaces the current entry without losing router state", () => {
    const browser = invitationBrowser("#token=private%2Btoken");
    expect(takeInvitationToken(browser.location, browser.history)).toBe(
      "private+token",
    );
    expect(browser.history.replaceState).toHaveBeenCalledWith(
      browser.state,
      "",
      "/dashboard/auth/invite?view=invitation",
    );
    expect(browser.location.hash).toBe("");
    expect(takeInvitationToken(browser.location, browser.history)).toBeNull();
  });

  it.each(["", "#token=", "#token=one&token=two", "#other=secret"])(
    "rejects missing or ambiguous tokens and still clears the fragment: %s",
    (hash) => {
      const browser = invitationBrowser(hash);
      expect(takeInvitationToken(browser.location, browser.history)).toBeNull();
      expect(browser.location.hash).toBe("");
      expect(browser.history.replaceState).toHaveBeenCalledTimes(1);
    },
  );

  it("does not take invitation secrets from query parameters", () => {
    const browser = invitationBrowser("");
    browser.location.search = "?token=not-a-fragment";
    expect(takeInvitationToken(browser.location, browser.history)).toBeNull();
  });
});

describe("account UI role choices", () => {
  it("limits managers to Author and Viewer while allowing admins every workspace role", () => {
    expect(manageableAccountRoles(RoleEnum.WorkspaceManager)).toEqual([
      RoleEnum.Author,
      RoleEnum.Viewer,
    ]);
    expect(manageableAccountRoles(RoleEnum.Admin)).toEqual(
      Object.values(RoleEnum),
    );
    expect(manageableAccountRoles(RoleEnum.Author)).toEqual([]);
    expect(manageableAccountRoles(RoleEnum.Viewer)).toEqual([]);
  });
});

describe("safe account errors", () => {
  it("keeps a wrong-account invitation retry distinct from an expired or revoked invitation", () => {
    const mismatch = authErrorMessage("invitation_email_mismatch");
    expect(mismatch).toMatch(/invitation remains valid/i);
    expect(mismatch).toMatch(/reopen the original private invitation link/i);
    expect(mismatch).toMatch(/choose the Google account named on it/i);
    expect(mismatch).not.toMatch(/new link|replac|expired|revoked/i);
    expect(authErrorMessage("invalid_invitation")).toMatch(/expired, revoked/);
    expect(authErrorMessage("invalid_invitation")).toMatch(/new link/i);
    expect(
      accountErrorMessage({
        isAxiosError: true,
        response: { status: 400, data: { code: "invitation_email_mismatch" } },
      }),
    ).toBe(mismatch);
  });

  it.each([
    "__proto__",
    "constructor",
    "toString",
    "provider-error-with-secret",
  ])("does not render arbitrary or inherited auth error values: %s", (code) => {
    const message = authErrorMessage(code);
    expect(typeof message).toBe("string");
    expect(message).not.toContain(code);
    expect(message).toBe(authErrorMessage("unknown"));
  });

  it("renders the safe policy explanation rather than a raw transport/provider error", () => {
    const error = {
      isAxiosError: true,
      message: "provider secret must not render",
      response: {
        status: 409,
        data: { code: "last_administrator", message: "raw secret" },
      },
    };
    expect(accountErrorMessage(error)).toMatch(/another administrator/i);
    expect(accountErrorMessage(error)).not.toMatch(/secret/);
  });

  it("does not echo an unknown server error message", () => {
    const error = {
      isAxiosError: true,
      response: {
        status: 400,
        data: { code: "unknown", message: "raw secret" },
      },
    };
    expect(accountErrorMessage(error)).not.toMatch(/secret/);
  });
});
