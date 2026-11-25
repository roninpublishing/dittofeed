/** Adapted from yuriyward/mail-tracker gmail-prefetch.test.ts at 51ea4e7551564f6ddb55b60a34754863400e9133. */
import { gmailProxyReason } from "./gmail-proxy";

test.each([
  ["on-open image proxy: IP in the Google service IP list (goog.json minus cloud.json)", true],
  ["on-open image proxy (GoogleImageProxy)", true],
  ["on-open image proxy (GGPHT.COM)", true],
  ["on-open image proxy (Google)", true],
  ["on-open image proxy (GoogleCloud)", false],
  ["on-open image proxy (_Google_)", false],
  ["on-open image proxy (YahooMailProxy)", false],
  ["on-open image proxy (Outlook-ImageProxy)", false],
  ["", false],
] as const)("Gmail reason %s", (reason, expected) => {
  expect(gmailProxyReason.matches(reason)).toBe(expected);
});
