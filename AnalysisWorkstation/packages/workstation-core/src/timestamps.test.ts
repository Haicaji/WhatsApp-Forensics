import assert from "node:assert/strict";
import test from "node:test";

import { normalizeEvidenceTimestamp } from "./timestamps.js";

test("evidence timestamps normalize seconds, milliseconds and offsets to UTC", () => {
  assert.equal(normalizeEvidenceTimestamp(1_755_651_900), "2025-08-20T01:05:00.000Z");
  assert.equal(normalizeEvidenceTimestamp("1755651900000"), "2025-08-20T01:05:00.000Z");
  assert.equal(
    normalizeEvidenceTimestamp("2025-08-20T09:05:00+08:00"),
    "2025-08-20T01:05:00.000Z",
  );
});

test("offset-free evidence timestamps are interpreted as UTC, not local time", () => {
  assert.equal(
    normalizeEvidenceTimestamp("2026-08-20 01:02:03"),
    "2026-08-20T01:02:03.000Z",
  );
  assert.equal(normalizeEvidenceTimestamp("not-a-time"), "not-a-time");
});
