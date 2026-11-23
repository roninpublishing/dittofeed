/** @jest-environment jsdom */

import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

import { Link } from "../tipTapExtensions/link";
import { isValidLinkUrl } from "./isValidLinkUrl";

const templateUrl =
  "https://example.invalid/read?e={{ subscriber_email }}&id={{ user.id | sha256 }}";

describe("isValidLinkUrl", () => {
  it.each([
    templateUrl,
    "https://example.invalid/{{user.id}}",
    "https://example.invalid/?name={{ user['first name'] | default: 'A B' | url_encode }}",
    "https://example.invalid/?e={{- subscriber_email | strip | downcase | md5 -}}",
    "https://example.invalid/?e={{ subscriber_email | default: 'a:b,c' }}",
    "https://example.invalid/read?subscriber_email=authored%2Bvalue#section",
    "http://localhost:3000/path",
    "https://[::1]:443/path",
    "mailto:person@example.invalid",
    "tel:+15551234567",
    "ftp://example.invalid/file",
    "custom:opaque-value",
  ])("accepts supported literal and explicit template URLs: %s", (url) => {
    expect(isValidLinkUrl(url)).toBe(true);
  });

  it.each([
    "",
    "example.invalid/path",
    "https://",
    "https://[invalid]/path",
    "https://example.invalid:bad/path",
    " https://example.invalid",
    "https://example.invalid/path with spaces",
    "https://example.invalid/\n?e={{ subscriber_email }}",
    "https://example.invalid/?e={{ subscriber_email }",
    "https://example.invalid/?e=subscriber_email }}",
    "https://example.invalid/?e={{ }}",
    "https://example.invalid/?e={{ user.id | }}",
    "https://example.invalid/?e={{ user.id | sha256 | }}",
    "https://example.invalid/?e={{ user.id | default: }}",
    "https://example.invalid/?e={{ user.id | default: 'x', }}",
    "https://example.invalid/?e={{ user.id nonsense }}",
    "https://example.invalid/?e={{ user['unclosed] }}",
    "https://example.invalid/?e={% assign x = 1 %}",
    "{{ user.scheme }}://example.invalid",
    "javascript:alert(1)",
    "data:text/html,unsafe",
  ])("rejects invalid URLs and malformed template expressions: %s", (url) => {
    expect(isValidLinkUrl(url)).toBe(false);
  });

  it.each(["_blank", ""])(
    "preserves authored href and target %j through link mark editing and HTML",
    (target) => {
      const editor = new Editor({
        extensions: [StarterKit, Link],
        content: "<p>Read more</p>",
      });
      let restored: Editor | undefined;
      try {
        editor.commands.selectAll();
        editor.commands.setLink({ href: templateUrl, target });
        expect(editor.getAttributes("link")).toMatchObject({
          href: templateUrl,
          target,
        });

        restored = new Editor({
          extensions: [StarterKit, Link],
          content: editor.getHTML(),
        });
        restored.commands.setTextSelection(3);
        expect(restored.getAttributes("link")).toMatchObject({
          href: templateUrl,
          target,
        });
        const editedUrl = `${templateUrl}&name={{ user.firstName | url_encode }}`;
        restored
          .chain()
          .extendMarkRange("link")
          .setLink({ href: editedUrl, target })
          .run();
        expect(restored.getJSON().content?.[0]?.content).toEqual([
          expect.objectContaining({
            text: "Read more",
            marks: [
              expect.objectContaining({
                type: "link",
                attrs: expect.objectContaining({ href: editedUrl, target }),
              }),
            ],
          }),
        ]);
      } finally {
        restored?.destroy();
        editor.destroy();
      }
    },
  );
});
