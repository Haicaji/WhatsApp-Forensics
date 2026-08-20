import assert from "node:assert/strict";
import test from "node:test";

import { parseRange } from "./range.js";

test("media byte ranges stay inside the file", () => {
  assert.deepEqual(parseRange("bytes=5-12", 20), { start: 5, end: 12 });
  assert.deepEqual(parseRange("bytes=8-", 10), { start: 8, end: 9 });
  assert.equal(parseRange("bytes=20-30", 20), null);
  assert.equal(parseRange("items=1-2", 20), null);
});
