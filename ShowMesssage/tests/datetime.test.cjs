const test = require("node:test");
const assert = require("node:assert/strict");

const DateTime = require("../frontend/datetime.js");

test("defaults to Asia/Shanghai when a stored time zone is invalid", () => {
  assert.equal(DateTime.DEFAULT_TIME_ZONE, "Asia/Shanghai");
  assert.equal(DateTime.normalizeTimeZone("Mars/Olympus"), "Asia/Shanghai");
  assert.equal(DateTime.normalizeTimeZone("UTC"), "UTC");
});

test("groups the same timestamp into the selected time zone's calendar date", () => {
  const timestamp = Date.parse("2023-12-31T16:30:00Z") / 1000;
  assert.equal(DateTime.dateKey(timestamp, "Asia/Shanghai"), "2024-01-01");
  assert.equal(DateTime.dateKey(timestamp, "America/New_York"), "2023-12-31");
});

test("formats historical UTC offsets, including daylight saving time", () => {
  const summer = Date.parse("2026-07-17T12:00:00Z") / 1000;
  const winter = Date.parse("2026-01-17T12:00:00Z") / 1000;
  assert.equal(DateTime.offsetLabel("Asia/Shanghai", summer), "UTC+08:00");
  assert.equal(DateTime.offsetLabel("America/New_York", summer), "UTC-04:00");
  assert.equal(DateTime.offsetLabel("America/New_York", winter), "UTC-05:00");
});

test("appends the selected UTC offset to inline and floating date labels", () => {
  const timestamp = Date.parse("2026-07-15T12:00:00Z") / 1000;
  assert.equal(
    DateTime.appendOffsetLabel("2026年7月15日", "Asia/Shanghai", timestamp),
    "2026年7月15日 (UTC+08:00)",
  );
  assert.equal(
    DateTime.appendOffsetLabel("2026年7月15日", "America/New_York", timestamp),
    "2026年7月15日 (UTC-04:00)",
  );
});

test("calendar date helpers remain stable across leap days", () => {
  assert.equal(DateTime.shiftDateKey("2024-03-01", -1), "2024-02-29");
  const date = DateTime.calendarDateFromKey("2026-07-17");
  assert.equal(DateTime.calendarDateKey(date), "2026-07-17");
  assert.equal(DateTime.calendarDateFromKey("2026-02-30"), null);
});
