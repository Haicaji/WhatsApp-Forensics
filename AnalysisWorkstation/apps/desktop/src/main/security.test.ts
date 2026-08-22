import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAssetResponse } from "./asset-response.js";
import { parseRange } from "./range.js";

test("media byte ranges stay inside the file", () => {
  assert.deepEqual(parseRange("bytes=5-12", 20), { start: 5, end: 12 });
  assert.deepEqual(parseRange("bytes=8-", 10), { start: 8, end: 9 });
  assert.equal(parseRange("bytes=20-30", 20), null);
  assert.equal(parseRange("items=1-2", 20), null);
});

test("media responses stream Windows paths longer than MAX_PATH", async () => {
  const root = mkdtempSync(join(tmpdir(), "wafc-long-media-"));
  try {
    let directory = root;
    while (join(directory, "asset.jpg").length <= 280) {
      directory = join(directory, "portable-release-segment");
    }
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "asset.jpg");
    const payload = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03, 0x04]);
    writeFileSync(path, payload);
    assert.ok(path.length > 260);

    const response = createAssetResponse(
      new Request("wafc-media://asset/00000000-0000-4000-8000-000000000000"),
      path,
      "image/jpeg",
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/jpeg");
    assert.equal(response.headers.get("content-length"), String(payload.length));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);

    const rangeResponse = createAssetResponse(
      new Request("wafc-media://asset/00000000-0000-4000-8000-000000000000", {
        headers: { Range: "bytes=2-5" },
      }),
      path,
      "image/jpeg",
    );
    assert.equal(rangeResponse.status, 206);
    assert.equal(rangeResponse.headers.get("content-range"), `bytes 2-5/${payload.length}`);
    assert.deepEqual(Buffer.from(await rangeResponse.arrayBuffer()), payload.subarray(2, 6));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
