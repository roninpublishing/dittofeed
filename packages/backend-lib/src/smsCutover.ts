// Cutover-only detection for saved definitions. These records remain in the
// database for operator review, but must not participate in active resources.
export function hasRetiredSmsChannel(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(hasRetiredSmsChannel);
  }
  const object = value as Record<string, unknown>;
  return object.type === "Sms" || object.channel === "Sms" ||
    Object.values(object).some(hasRetiredSmsChannel);
}
