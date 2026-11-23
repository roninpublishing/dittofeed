import { Tokenizer, TypeGuards } from "liquidjs";

/** Validate a stand-in URL, never normalize or encode the authored href. */
export function isValidLinkUrl(value: string): boolean {
  try {
    const tokens = new Tokenizer(value).readTopLevelTokens();
    let literalUrl = "";

    for (const token of tokens) {
      if (TypeGuards.isOutputToken(token)) {
        const expression = new Tokenizer(token.content);
        expression.readValueOrThrow();
        expression.skipBlank();
        while (!expression.end()) {
          const filter = expression.readFilter();
          if (!filter || /[:,]\s*$/.test(filter.getText())) {
            return false;
          }
          expression.skipBlank();
        }
        literalUrl += "liquid-value";
      } else if (TypeGuards.isHTMLToken(token)) {
        const text = token.getText();
        if (text.includes("}}") || text.includes("{{")) {
          return false;
        }
        literalUrl += text;
      } else {
        // Link fields support output expressions, not Liquid control-flow tags.
        return false;
      }
    }

    if (
      !/^[a-z][a-z\d+.-]*:/i.test(value) ||
      !/^(\S+):(\/\/)?\S+$/.test(literalUrl) ||
      /^(?:javascript|data|vbscript):/i.test(literalUrl)
    ) {
      return false;
    }
    new URL(literalUrl);
    return true;
  } catch {
    return false;
  }
}
