export function parseRange(
  value: string | null,
  size: number,
): { start: number; end: number } | null {
  if (value === null) return null;
  const match = /^bytes=(\d+)-(\d*)$/u.exec(value.trim());
  if (match === null) return null;
  const start = Number(match[1]);
  const requestedEnd = match[2] === "" ? size - 1 : Number(match[2]);
  const end = Math.min(requestedEnd, size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end) {
    return null;
  }
  return { start, end };
}
