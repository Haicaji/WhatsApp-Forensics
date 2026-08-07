(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ShowMessageDateTime = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_TIME_ZONE = "Asia/Shanghai";
  const datePartsFormatters = new Map();

  function isValidTimeZone(value) {
    const timeZone = String(value || "").trim();
    if (!timeZone) return false;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
      return true;
    } catch (_error) {
      return false;
    }
  }

  function normalizeTimeZone(value) {
    return isValidTimeZone(value) ? String(value).trim() : DEFAULT_TIME_ZONE;
  }

  function timestampDate(timestamp) {
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds)) return null;
    const date = new Date(seconds * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function partsFormatter(timeZone) {
    const normalized = normalizeTimeZone(timeZone);
    if (!datePartsFormatters.has(normalized)) {
      datePartsFormatters.set(
        normalized,
        new Intl.DateTimeFormat("en-CA", {
          timeZone: normalized,
          calendar: "gregory",
          numberingSystem: "latn",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hourCycle: "h23",
        }),
      );
    }
    return datePartsFormatters.get(normalized);
  }

  function dateParts(timestamp, timeZone) {
    const date = timestampDate(timestamp);
    if (!date) return null;
    const values = {};
    for (const part of partsFormatter(timeZone).formatToParts(date)) {
      if (part.type !== "literal") values[part.type] = Number(part.value);
    }
    if (![values.year, values.month, values.day].every(Number.isFinite)) return null;
    return {
      year: values.year,
      month: values.month,
      day: values.day,
      hour: Number.isFinite(values.hour) ? values.hour : 0,
      minute: Number.isFinite(values.minute) ? values.minute : 0,
      second: Number.isFinite(values.second) ? values.second : 0,
    };
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function dateKey(timestamp, timeZone) {
    const parts = dateParts(timestamp, timeZone);
    if (!parts) return "";
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  }

  function parseDateKey(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year
      || date.getUTCMonth() !== month - 1
      || date.getUTCDate() !== day
    ) return null;
    return { year, month, day };
  }

  function calendarDateFromKey(value) {
    const parts = parseDateKey(value);
    return parts ? new Date(Date.UTC(parts.year, parts.month - 1, parts.day)) : null;
  }

  function calendarDateKey(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  }

  function shiftDateKey(value, days) {
    const date = calendarDateFromKey(value);
    if (!date) return "";
    date.setUTCDate(date.getUTCDate() + Number(days || 0));
    return calendarDateKey(date);
  }

  function calculatedOffsetMinutes(timeZone, timestamp) {
    const date = timestampDate(timestamp);
    const parts = dateParts(timestamp, timeZone);
    if (!date || !parts) return 0;
    const representedAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const sourceRoundedToSecond = Math.floor(date.getTime() / 1000) * 1000;
    return Math.round((representedAsUtc - sourceRoundedToSecond) / 60000);
  }

  function offsetLabel(timeZone, timestamp) {
    const normalized = normalizeTimeZone(timeZone);
    const seconds = Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now() / 1000;
    const date = timestampDate(seconds) || new Date();
    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: normalized,
        timeZoneName: "longOffset",
      });
      const zoneName = formatter.formatToParts(date).find((part) => part.type === "timeZoneName")?.value || "";
      if (/^(GMT|UTC)$/.test(zoneName)) return "UTC+00:00";
      const match = /^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(zoneName);
      if (match) return `UTC${match[1]}${pad(match[2])}:${pad(match[3] || 0)}`;
    } catch (_error) {
      // 使用下方按日期部件计算的兼容路径。
    }
    const offset = calculatedOffsetMinutes(normalized, seconds);
    const sign = offset < 0 ? "-" : "+";
    const absolute = Math.abs(offset);
    return `UTC${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
  }

  function appendOffsetLabel(label, timeZone, timestamp) {
    return `${String(label || "")} (${offsetLabel(timeZone, timestamp)})`;
  }

  return {
    DEFAULT_TIME_ZONE,
    isValidTimeZone,
    normalizeTimeZone,
    dateParts,
    dateKey,
    parseDateKey,
    calendarDateFromKey,
    calendarDateKey,
    shiftDateKey,
    offsetLabel,
    appendOffsetLabel,
  };
});
