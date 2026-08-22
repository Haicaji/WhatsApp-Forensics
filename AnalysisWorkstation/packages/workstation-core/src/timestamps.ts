const UNIX_SECONDS_LIMIT = 10_000_000_000;
const NUMERIC_TIMESTAMP = /^[+-]?\d+(?:\.\d+)?$/u;
const DATE_WITHOUT_TIME_ZONE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/u;

/**
 * Converts timestamps from Field Collector and legacy result sets to a canonical
 * UTC ISO-8601 value. A timestamp without an offset is treated as UTC instead of
 * inheriting the workstation's local time zone.
 */
export function normalizeEvidenceTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.valueOf()) ? null : value.toISOString();
  }

  const text = typeof value === "string" ? value.trim() : String(value);
  if (text === "") return null;

  if (typeof value === "number" || NUMERIC_TIMESTAMP.test(text)) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      const milliseconds = Math.abs(numeric) < UNIX_SECONDS_LIMIT ? numeric * 1000 : numeric;
      const date = new Date(milliseconds);
      if (!Number.isNaN(date.valueOf())) return date.toISOString();
    }
  }

  const parseable = DATE_WITHOUT_TIME_ZONE.test(text)
    ? `${text.replace(" ", "T")}Z`
    : text;
  const date = new Date(parseable);
  return Number.isNaN(date.valueOf()) ? text : date.toISOString();
}
