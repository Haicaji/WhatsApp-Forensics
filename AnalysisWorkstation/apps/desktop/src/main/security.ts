import {
  BrowserWindow,
  protocol,
  session,
} from "electron";

import type { WorkstationService } from "@wafc/workstation-core";

import { createAssetResponse } from "./asset-response.js";

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
      return createAssetResponse(request, asset.path, asset.mimeType);
    } catch (error) {
      console.error(
        "Media protocol request failed.",
        error instanceof Error ? error.message : String(error),
      );
      return new Response("Not found", { status: 404 });
    }
  });
}
