import { join, resolve } from "node:path";

import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  protocol,
} from "electron";

import {
  initializeWorkstationPaths,
  resolveDataRoot,
  toWorkstationError,
  WorkstationService,
  type WorkstationPaths,
} from "@wafc/workstation-core";

import { registerIpc } from "./ipc.js";
import {
  hardenSession,
  hardenWindow,
  MEDIA_SCHEME,
  registerMediaProtocol,
} from "./security.js";
import { IPC_CHANNELS } from "../shared/api.js";

protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

const projectRoot = resolve(app.getAppPath(), "../..");
let startupPaths: WorkstationPaths | null = null;
let startupError: Error | null = null;
try {
  const dataRoot = resolveDataRoot({
    isPackaged: app.isPackaged,
    executablePath: process.execPath,
    projectRoot,
    environment: process.env,
  });
  startupPaths = initializeWorkstationPaths(dataRoot);
  app.setPath("userData", startupPaths.electronUserData);
  app.setPath("sessionData", startupPaths.electronSessionData);
  app.setPath("crashDumps", startupPaths.electronCrashDumps);
  app.setAppLogsPath(startupPaths.logsDirectory);
} catch (error) {
  startupError = error instanceof Error ? error : new Error(String(error));
}

let service: WorkstationService | null = null;

void app.whenReady().then(async () => {
  if (startupPaths === null) {
    const error = toWorkstationError(startupError);
    dialog.showErrorBox("WAFC Analysis Workstation 无法启动", error.userMessage);
    app.quit();
    return;
  }
  app.setAppUserModelId("org.wafc.analysis-workstation");
  Menu.setApplicationMenu(null);
  const collectorPayloadRoot = app.isPackaged
    ? join(process.resourcesPath, "field-collector-payload")
    : join(projectRoot, "resources", "field-collector-payload");
  service = new WorkstationService({
    dataRoot: startupPaths.dataRoot,
    collectorPayloadRoot,
  });
  registerIpc(service);
  hardenSession();
  registerMediaProtocol(service);
  await createMainWindow();
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  service?.close();
  service = null;
});

async function createMainWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    frame: false,
    title: "WAFC Analysis Workstation",
    backgroundColor: "#F4F5F8",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  hardenWindow(window);
  const notifyMaximized = (): void => {
    window.webContents.send(IPC_CHANNELS.windowMaximizedChanged, window.isMaximized());
  };
  window.on("maximize", notifyMaximized);
  window.on("unmaximize", notifyMaximized);
  window.once("ready-to-show", () => window.show());
  await window.loadFile(join(import.meta.dirname, "../../renderer/index.html"));
}
