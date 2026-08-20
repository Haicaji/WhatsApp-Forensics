import type { ApiResult } from "../../shared/api";

export class UiApiError extends Error {
  readonly code: string;
  readonly eventId: string;

  constructor(code: string, message: string, eventId: string) {
    super(message);
    this.name = "UiApiError";
    this.code = code;
    this.eventId = eventId;
  }
}

export function unwrap<T>(result: ApiResult<T>): T {
  if (result.ok) return result.value;
  throw new UiApiError(
    result.error.code,
    result.error.userMessage,
    result.error.eventId,
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatDateTime(value: string | null): string {
  if (value === null || value === "") return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatCompactDate(value: string | null): string {
  if (value === null || value === "") return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

export function formatBytes(value: number | null): string {
  if (value === null) return "大小未知";
  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}
