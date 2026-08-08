import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  BrowserWindow,
  app,
  net,
  protocol,
  session,
} from "electron";

import { WorkstationService } from "@wafc/workstation-core";

import { registerIpcHandlers } from "./ipc";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "wafc",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
    },
  },
]);

let service: WorkstationService | null = null;
let rendererProtocolRegistered = false;

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

function developmentPaths() {
  const analysisRoot = resolve(__dirname, "../../../../..");
  const repositoryRoot = resolve(analysisRoot, "..");
  const suffix = process.platform === "win32" ? ".exe" : "";
  return {
    provisionerExecutable: join(
      analysisRoot,
      "tools",
      "usb-provisioner",
      "target",
      "release",
      `wafc-usb-provisioner${suffix}`,
    ),
    verifierExecutable: join(
      repositoryRoot,
      "tools",
      "verify-cli",
      "target",
      "release",
      `waeb-verify${suffix}`,
    ),
    collectorReleaseDirectory: join(
      repositoryRoot,
      "field-collector",
      "out",
      "whatsapp-field-collector-v0.1.0-windows-x86_64",
    ),
  };
}

function productionPaths() {
  const suffix = process.platform === "win32" ? ".exe" : "";
  return {
    provisionerExecutable: join(
      process.resourcesPath,
      "tools",
      `wafc-usb-provisioner${suffix}`,
    ),
    verifierExecutable: join(
      process.resourcesPath,
      "tools",
      `waeb-verify${suffix}`,
    ),
    collectorReleaseDirectory: join(
      process.resourcesPath,
      "field-collector-portable",
    ),
  };
}

function registerRendererProtocol(rendererRoot: string): void {
  if (rendererProtocolRegistered) return;
  rendererProtocolRegistered = true;
  protocol.handle("wafc", (request) => {
    const requestUrl = new URL(request.url);
    if (requestUrl.hostname !== "app") {
      return new Response("Not found", { status: 404 });
    }
    const decoded = decodeURIComponent(requestUrl.pathname);
    const relativePath = decoded === "/" ? "index.html" : decoded.slice(1);
    if (
      !relativePath ||
      relativePath.includes("\\") ||
      relativePath.split("/").some((part) => part === ".." || part === ".")
    ) {
      return new Response("Bad request", { status: 400 });
    }
    const file = resolve(rendererRoot, ...relativePath.split("/"));
    const fromRoot = relative(rendererRoot, file);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || !existsSync(file)) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(file).toString()).then((response) => {
      const headers = new Headers(response.headers);
      headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    });
  });
}

function workstationDataRoot(): string {
  const testOverride = process.env.WAFC_TEST_DATA_ROOT;
  if (!app.isPackaged && testOverride) {
    if (!isAbsolute(testOverride)) {
      throw new Error("WAFC_TEST_DATA_ROOT 必须是绝对路径");
    }
    return resolve(testOverride);
  }
  return join(app.getPath("userData"), "workstation-data");
}

async function createWindow(): Promise<BrowserWindow> {
  const rendererRoot = resolve(__dirname, "../../renderer");
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: "#f4f6fb",
    title: "WAFC Analysis Workstation",
    webPreferences: {
      preload: resolve(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.once("ready-to-show", () => window.show());

  const toolPaths = app.isPackaged ? productionPaths() : developmentPaths();
  service = new WorkstationService({
    dataRoot: workstationDataRoot(),
    ...toolPaths,
  });
  registerIpcHandlers(window, service);

  if (
    !app.isPackaged &&
    process.env.WAFC_DEV_SERVER_URL === "http://127.0.0.1:5173"
  ) {
    await window.loadURL(process.env.WAFC_DEV_SERVER_URL);
  } else {
    registerRendererProtocol(rendererRoot);
    await window.loadURL("wafc://app/index.html");
  }
  return window;
}

app.whenReady().then(async () => {
  app.setAppUserModelId("org.whatsapp-forensics.analysis-workstation");
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (service) void service.close();
  service = null;
});
