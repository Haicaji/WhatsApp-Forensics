import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";

import { parseRange } from "./range.js";

export function createAssetResponse(
  request: Request,
  path: string,
  mimeType: string | null,
): Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  const size = statSync(path).size;
  const rangeHeader = request.headers.get("range");
  const range = parseRange(rangeHeader, size);
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Type": mimeType ?? "application/octet-stream",
  });

  if (rangeHeader !== null && range === null) {
    headers.set("Content-Range", `bytes */${size}`);
    headers.set("Content-Length", "0");
    return new Response(null, { status: 416, headers });
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, size - 1);
  const contentLength = size === 0 ? 0 : end - start + 1;
  headers.set("Content-Length", String(contentLength));
  if (range !== null) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);

  const status = range === null ? 200 : 206;
  if (request.method === "HEAD" || size === 0) {
    return new Response(null, { status, headers });
  }

  // Chromium's file URL loader can return ERR_FILE_NOT_FOUND for otherwise
  // valid Windows paths once the absolute path exceeds MAX_PATH.  Reading the
  // validated file through Node keeps portable cases functional in deeply
  // nested release directories without exposing a filesystem path to Renderer.
  const body = Readable.toWeb(createReadStream(path, { start, end })) as unknown as BodyInit;
  return new Response(body, { status, headers });
}
