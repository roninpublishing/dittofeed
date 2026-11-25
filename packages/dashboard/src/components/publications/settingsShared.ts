import axios from "axios";
import { isObject } from "isomorphic-lib/src/objects";

export type RecordValue = Record<string, unknown>;
export interface Option {
  value: string;
  label: string;
}

export function record(value: unknown): RecordValue {
  return isObject(value) ? value : {};
}

export function rows(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.map(record) : [];
}

export function text(value: unknown): string {
  if (value === undefined || value === null) return "—";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function errorText(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = record(error.response?.data);
    return typeof data.message === "string"
      ? data.message
      : "Workspace operation failed";
  }
  return error instanceof SyntaxError
    ? "Invalid JSON in an advanced field"
    : "Workspace operation failed";
}
