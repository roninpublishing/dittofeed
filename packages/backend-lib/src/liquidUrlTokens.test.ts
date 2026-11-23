import { renderLiquid } from "./liquid";
import { UserPropertyAssignments } from "./userProperties";

const recipient = '"Actual Reader" <actual+edition@example.invalid>';
const emailSha256 = "6fa50bd680b2d952ddad4025b09c0a0d130f2f107831b67a33cfdeea252f1338";
const emailMd5 = "6be3745f0cf9db53ee53afa4d05cbad1";

function render(template: string, userProperties: UserPropertyAssignments = {}, identifierKey?: string) {
  return renderLiquid({ template, workspaceId: "token-test", userProperties, identifierKey });
}

describe("explicit URL contact tokens", () => {
  it("leaves literal URLs and existing attribution parameters unchanged", () => {
    const template = '<a href="https://example.invalid/read?a=1%202&subscriber_email=authored#part">Read</a><a href="https://other.invalid/?signature=signed">Other</a>';
    expect(render(template, { email: recipient })).toBe(template);
  });

  it("encodes the actual To mailbox and arbitrary contact fields only where requested", () => {
    const result = render(
      "https://example.invalid/?e={{subscriber_email}}&name={{ user['first name'] | url_encode }}#part",
      { email: "wrong@example.invalid", destination: recipient, "first name": "München & A+B" },
      "destination",
    );
    const url = new URL(result);
    expect(url.searchParams.get("e")).toBe("actual+edition@example.invalid");
    expect(url.searchParams.get("name")).toBe("München & A+B");
    expect(url.hash).toBe("#part");
    expect(result).toContain("actual%2Bedition%40example.invalid");
    expect(result).not.toContain("wrong");
  });

  it("hashes raw recipient bytes, not its percent-encoded output", () => {
    expect(render(
      "{{ subscriber_email | sha256 }}|{{subscriber_email_sha256}}|{{ subscriber_email | md5 }}|{{subscriber_email_md5}}",
      { email: recipient },
    )).toBe(`${emailSha256}|${emailSha256}|${emailMd5}|${emailMd5}`);
  });

  it.each([
    ["sha256", "abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["md5", "abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["sha256", "München & A+B", "c38d38860301d8df47621e540c6ef44b722c771061009fcfbda0f449732e0f4a"],
    ["md5", "München & A+B", "159a203bf3398594dd9ab64ed172c19a"],
    ["md5", 42, "a1d0c6e83f027327d8461063f4ac58a6"],
    ["md5", true, "b326b5062b2f0e69046810717534cb09"],
  ])("supports exact scalar UTF-8 %s hashes", (algorithm, value, expected) => {
    expect(render(`{{ user.value | ${algorithm} }}`, { value })).toBe(expected);
  });

  it("normalizes only through explicitly authored filters", () => {
    expect(render("{{ user.value | strip | downcase | sha256 }}", { value: " ABC " }))
      .toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(render("{{ user.value | sha256 }}", { value: " ABC " }))
      .not.toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("does not encode explicitly encoded recipient outputs twice", () => {
    expect(render("{{ subscriber_email | url_encode }}", { email: recipient }))
      .toBe("actual%2Bedition%40example.invalid");
  });

  it("preserves raw blocks, comments, conditionals, and whitespace control", () => {
    expect(render(
      "{% raw %}{{subscriber_email}}{% endraw %}|{% comment %}{{subscriber_email}}{% endcomment %}{% if user.enabled %} {{- subscriber_email -}} {% endif %}",
      { email: recipient, enabled: true },
    )).toBe("{{subscriber_email}}|actual%2Bedition%40example.invalid");
  });

  it("does not reinterpret contact values as Liquid", () => {
    const value = "{{subscriber_email}}&other={{user.secret}}";
    const url = new URL(render("https://example.invalid/?name={{ user.name | url_encode }}", {
      email: recipient, name: value, secret: "must-not-be-interpreted",
    }));
    expect(url.searchParams.get("name")).toBe(value);
  });

  it("retains raw existing user-field text semantics and complete URL fields", () => {
    expect(render('{{ user.email }}|<a href="{{ user.target | escape }}">Read</a>', {
      email: "A+B@example.invalid", target: "https://example.invalid/?a=1&b=2",
    })).toBe('A+B@example.invalid|<a href="https://example.invalid/?a=1&amp;b=2">Read</a>');
  });

  it.each<UserPropertyAssignments>([
    {},
    { email: "a@example.invalid, b@example.invalid" },
    { email: "unsafe\r\n@example.invalid" },
    { email: "not-an-email" },
    { email: "wrong@example.invalid", destination: null },
  ])("fails required recipient aliases instead of guessing a mailbox", (properties) => {
    expect(() => render("{{subscriber_email}}", properties, "destination" in properties ? "destination" : undefined)).toThrow();
  });

  it("requires missing contact fields, with explicit defaults available", () => {
    expect(() => render("{{ user.missing | sha256 }}")).toThrow();
    expect(render("{{ user.missing | default: 'n/a' | url_encode }}")).toBe("n%2Fa");
    expect(render("{{ subscriber_email | default: 'missing+address@example.invalid' }}"))
      .toBe("missing%2Baddress%40example.invalid");
    expect(render("{{ user.missing | default: '' | sha256 }}"))
      .toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it.each([{ value: ["secret-value"] }, { value: { sensitive: "secret-value" } }])("rejects non-scalar hash inputs without dumping values", ({ value }) => {
    expect(() => render("{{ user.value | sha256 }}", { value }))
      .toThrow("Hash input must be a string, number, or boolean.");
  });

  it("renders explicit recipient tokens through MJML", () => {
    const html = renderLiquid({
      template: '<mjml><mj-body><mj-section><mj-column><mj-button href="https://example.invalid/?e={{subscriber_email}}&amp;hash={{subscriber_email_md5}}">Read</mj-button></mj-column></mj-section></mj-body></mjml>',
      workspaceId: "token-test", userProperties: { email: recipient }, mjml: true,
    });
    expect(html).toContain(`https://example.invalid/?e=actual%2Bedition%40example.invalid&amp;hash=${emailMd5}`);
  });
});
