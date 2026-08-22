import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "electron";
import { z } from "zod";

import type { WorkstationService } from "@wafc/workstation-core";
import { toWorkstationError } from "@wafc/workstation-core";

import {
  IPC_CHANNELS,
  type ApiResult,
  type OpenFolderInput,
} from "../shared/api.js";

const openFolderInputSchema = z.discriminatedUnion("target", [
  z.object({ target: z.enum(["data", "defaultCases"]) }),
  z.object({ target: z.literal("case"), caseId: z.uuid() }),
  z.object({ target: z.literal("task"), caseId: z.uuid(), taskId: z.uuid() }),
]);

type Handler<T> = (event: IpcMainInvokeEvent, ...arguments_: unknown[]) => T | Promise<T>;

function register<T>(channel: string, handler: Handler<T>): void {
  ipcMain.handle(channel, async (event, ...arguments_): Promise<ApiResult<T>> => {
    try {
      return { ok: true, value: await handler(event, ...arguments_) };
    } catch (error) {
      const eventId = randomUUID();
      const workstationError = toWorkstationError(error);
      console.error(`[${eventId}] ${channel}`, error);
      return {
        ok: false,
        error: {
          code: workstationError.code,
          userMessage: workstationError.userMessage,
          eventId,
        },
      };
    }
  });
}

export function registerIpc(service: WorkstationService): void {
  register(IPC_CHANNELS.casesList, () => service.listCases());
  register(IPC_CHANNELS.casesOpen, (_event, caseId) => service.openCase(String(caseId)));
  register(IPC_CHANNELS.casesCreate, (_event, input) => service.createCase(input as never));
  register(IPC_CHANNELS.casesChooseParent, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: "选择案件保存位置",
      buttonLabel: "选择此目录",
      defaultPath: service.paths.defaultCasesDirectory,
      properties: ["openDirectory", "createDirectory"],
    };
    const result = window === null
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(window, options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  register(IPC_CHANNELS.casesSettings, () => service.getSettingsInfo());
  register(IPC_CHANNELS.casesOpenFolder, async (_event, input) => {
    const parsed = openFolderInputSchema.parse(input) as OpenFolderInput;
    let path: string;
    switch (parsed.target) {
      case "data":
        path = service.paths.dataRoot;
        break;
      case "defaultCases":
        path = service.paths.defaultCasesDirectory;
        break;
      case "case":
        path = service.getCaseDirectory(parsed.caseId);
        break;
      case "task":
        path = service.getTaskDirectory(parsed.caseId, parsed.taskId);
        break;
    }
    const result = await shell.openPath(path);
    if (result !== "") throw new Error(result);
    return { opened: true as const };
  });

  register(IPC_CHANNELS.tasksList, (_event, caseId) => service.listTasks(String(caseId)));
  register(IPC_CHANNELS.tasksAssign, (_event, input) => service.assignTask(input as never));
  register(IPC_CHANNELS.tasksDisable, (_event, caseId, taskId) =>
    service.disableTask(String(caseId), String(taskId)),
  );
  register(IPC_CHANNELS.tasksChooseUsb, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: "选择 U 盘根目录",
      buttonLabel: "选择此目录",
      properties: ["openDirectory"],
    };
    const result = window === null
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(window, options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  register(IPC_CHANNELS.resultsChoose, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: "选择采集 session 或 U 盘根目录",
      buttonLabel: "接收此目录",
      properties: ["openDirectory"],
    };
    const result = window === null
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(window, options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  register(IPC_CHANNELS.resultsReceive, (_event, input) => service.receiveResults(input as never));

  register(IPC_CHANNELS.repositorySources, (_event, caseId) =>
    service.listSources(String(caseId)),
  );
  register(IPC_CHANNELS.repositorySourceWorkspace, (_event, caseId, sourceId) =>
    service.getSourceWorkspace(String(caseId), String(sourceId)),
  );
  register(IPC_CHANNELS.repositoryChats, (_event, caseId, query) =>
    service.listChats(String(caseId), query as never),
  );
  register(IPC_CHANNELS.repositoryMessages, (_event, caseId, query) =>
    service.listMessages(String(caseId), query as never),
  );
  register(IPC_CHANNELS.repositoryExportOfflinePreview, async (event, caseId, sourceId) => {
    const parsedCaseId = String(caseId);
    const parsedSourceId = String(sourceId);
    const window = BrowserWindow.fromWebContents(event.sender);
    const options: SaveDialogOptions = {
      title: "导出 WhatsApp 离线预览",
      buttonLabel: "导出",
      defaultPath: join(
        app.getPath("downloads"),
        service.getOfflinePreviewSuggestedFileName(parsedCaseId, parsedSourceId),
      ),
      filters: [{ name: "HTML 网页", extensions: ["html"] }],
      properties: ["showOverwriteConfirmation", "createDirectory"],
    };
    const result = window === null
      ? await dialog.showSaveDialog(options)
      : await dialog.showSaveDialog(window, options);
    if (result.canceled || result.filePath === "") return null;
    return service.exportOfflinePreview({
      caseId: parsedCaseId,
      sourceId: parsedSourceId,
      targetPath: result.filePath,
    });
  });
  register(IPC_CHANNELS.attachmentsOpen, async (_event, opaqueId) => {
    const asset = service.resolveAssetAcrossCases(String(opaqueId));
    const result = await shell.openPath(asset.path);
    if (result !== "") throw new Error(result);
    return { opened: true as const };
  });

  ipcMain.handle(IPC_CHANNELS.windowMinimize, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle(IPC_CHANNELS.windowToggleMaximize, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window?.isMaximized()) window.unmaximize();
    else window?.maximize();
  });
  ipcMain.handle(IPC_CHANNELS.windowClose, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle(IPC_CHANNELS.windowIsMaximized, (event) =>
    BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false,
  );
}
