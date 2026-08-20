import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";

import {
  BrowserWindow,
  protocol,
  session,
} from "electron";

import type { WorkstationService } from "@wafc/workstation-core";

import { parseRange } from "./range.js";

export const MEDIA_SCHEME = "wafc-media";

export function hardenSession(): void {
  const current = session.defaultSession;
  current.setPermissionCheckHandler(() => false);
  current.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  current.webRequest.onBeforeRequest((details, callback) => {
    const allowed =
      details.url.startsWith("file://") ||
      details.url.startsWith(`${MEDIA_SCHEME}://`);
    callback({ cancel: !allowed });
  });
}

export function hardenWindow(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
}

export function registerMediaProtocol(service: WorkstationService): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "asset" || !/^\/[0-9a-f-]{36}$/iu.test(url.pathname)) {
        return new Response("Not found", { status: 404 });
      }
      const opaqueId = url.pathname.slice(1);
      const asset = service.resolveAssetAcrossCases(opaqueId);
      return assetResponse(request, asset.path, asset.mimeType);
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

function assetResponse(
  request: Request,
  path: string,
  mimeType: string | null,
): Response {
  const size = statSync(path).size;
  const rangeHeader = request.headers.get("range");
  const range = parseRange(rangeHeader, size);
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Type": mimeType ?? "application/octet-stream",
  });
  if (range === null) {
    headers.set("Content-Length", String(size));
    if (request.method === "HEAD") return new Response(null, { status: 200, headers });
    const stream = Readable.toWeb(createReadStream(path));
    return new Response(stream as BodyInit, { status: 200, headers });
  }
  headers.set("Content-Length", String(range.end - range.start + 1));
  headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
  if (request.method === "HEAD") return new Response(null, { status: 206, headers });
  const stream = Readable.toWeb(createReadStream(path, range));
  return new Response(stream as BodyInit, { status: 206, headers });
}
