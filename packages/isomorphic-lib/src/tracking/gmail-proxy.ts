/** Adapted from yuriyward/mail-tracker, commit 51ea4e7551564f6ddb55b60a34754863400e9133. */
/* eslint-disable prefer-regex-literals -- Static constructors preserve Unicode semantics with this package's ES5 compile target. */
/** Shared Gmail proxy reason predicate; delivery-prefetch classification uses the same signatures. */
const signatures = [
  { text: "googleimageproxy", word: false },
  { text: "ggpht.com", word: false },
  { text: "google", word: true },
] as const;
const WORD_BOUNDARY = new RegExp(String.raw`\W`, "u");

export const gmailProxyReason = {
  matches: (reason: string): boolean => {
    const lower = reason.toLowerCase();
    return signatures.some(({ text, word }) =>
      word ? lower.split(WORD_BOUNDARY).includes(text) : lower.includes(text)
    );
  },
};
