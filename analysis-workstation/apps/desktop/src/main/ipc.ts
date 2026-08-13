import {
  type BrowserWindow,
  type IpcMainInvokeEvent,
  dialog,
  ipcMain,
} from "electron";
import { z } from "zod";

import {
  createCaseInputSchema,
  identifierSchema,
  initializeWorkstationInputSchema,
  inspectUsbSoftwareInputSchema,
  provisionUsbInputSchema,
  updateUsbSoftwareInputSchema,
} from "@wafc/domain";
import type { WorkstationService } from "@wafc/workstation-core";

import {
  IPC_CHANNELS,
  type ApiResult,
  type WorkstationApi,
} from "../shared/api";

const pathSchema = z.string().min(1).max(4096);
const chatQuerySchema = z.object({
  search: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().max(4096).nullable().optional(),
});
const messageQuerySchema = z.object({
  chatRecordId: z.string().min(1).max(240),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().max(4096).nullable().optional(),
  direction: z.enum(["forward", "backward"]).optional(),
});
const searchQuerySchema = z.object({
  text: z.string().min(1).max(1000),
  chatRecordId: z.string().min(1).max(240).optional(),
  sourceId: z.uuid().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().max(4096).nullable().optional(),
});

function errorResult(error: unknown): ApiResult<never> {
  return {
    ok: false,
    error: {
      code: "operation_failed",
      message: error instanceof Error ? error.message : "操作失败，请检查输入后重试",
    },
  };
}

function success<T>(value: T): ApiResult<T> {
  return { ok: true, value };
}

function assertTrustedSender(
  event: IpcMainInvokeEvent,
  window: BrowserWindow,
): void {
  if (
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  ) {
    throw new Error("已拒绝来自非主界面的请求");
  }
  const url = event.senderFrame.url;
  const allowed =
    url.startsWith("wafc://app/") ||
    (process.env.WAFC_DEV_SERVER_URL === "http://127.0.0.1:5173" &&
      url.startsWith("http://127.0.0.1:5173/"));
  if (!allowed) throw new Error("已拒绝来源不明的界面请求");
}

function handle<TArguments extends unknown[], TResult>(
  channel: string,
  window: BrowserWindow,
  operation: (...arguments_: TArguments) => Promise<TResult> | TResult,
): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, async (event, ...arguments_: unknown[]) => {
    try {
      assertTrustedSender(event, window);
      return success(await operation(...(arguments_ as TArguments)));
    } catch (error) {
      return errorResult(error);
    }
  });
}

export function registerIpcHandlers(
  window: BrowserWindow,
  service: WorkstationService,
): void {
  handle(IPC_CHANNELS.status, window, () => service.status());
  handle(IPC_CHANNELS.initializeWorkstation, window, (input: unknown) =>
    service.initializeWorkstation(initializeWorkstationInputSchema.parse(input)),
  );
  handle(IPC_CHANNELS.listCases, window, () => service.listCases());
  handle(IPC_CHANNELS.createCase, window, (input: unknown) =>
    service.createCase(createCaseInputSchema.parse(input)),
  );
  handle(IPC_CHANNELS.listAssignments, window, (caseId: unknown) =>
    service.listAssignments(identifierSchema.parse(caseId)),
  );
  handle(IPC_CHANNELS.chooseUsbRoot, window, async () => {
    const result = await dialog.showOpenDialog(window, {
      title: "选择取证 U 盘根目录",
      properties: ["openDirectory", "createDirectory", "promptToCreate"],
      buttonLabel: "选择此 U 盘",
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle(IPC_CHANNELS.chooseEvidenceBag, window, async () => {
    const result = await dialog.showOpenDialog(window, {
      title: "选择已封存 Evidence Bag 文件夹",
      properties: ["openDirectory"],
      buttonLabel: "选择证据包",
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle(IPC_CHANNELS.provisionUsb, window, (input: unknown) =>
    service.provisionUsb(provisionUsbInputSchema.parse(input)),
  );
  handle(IPC_CHANNELS.inspectUsbSoftware, window, (input: unknown) =>
    service.inspectUsbSoftware(inspectUsbSoftwareInputSchema.parse(input)),
  );
  handle(IPC_CHANNELS.updateUsbSoftware, window, (input: unknown) =>
    service.updateUsbSoftware(updateUsbSoftwareInputSchema.parse(input)),
  );
  handle(
    IPC_CHANNELS.intakeUsb,
    window,
    (caseId: unknown, usbRoot: unknown) =>
      service.intakeUsb(
        identifierSchema.parse(caseId),
        pathSchema.parse(usbRoot),
      ),
  );
  handle(IPC_CHANNELS.intakeUsbAutomatically, window, (usbRoot: unknown) =>
    service.intakeUsbAutomatically(pathSchema.parse(usbRoot)),
  );
  handle(
    IPC_CHANNELS.importEvidence,
    window,
    (caseId: unknown, bagPath: unknown) =>
      service.importEvidence(
        identifierSchema.parse(caseId),
        pathSchema.parse(bagPath),
      ),
  );
  handle(IPC_CHANNELS.getCaseSummary, window, (caseId: unknown) =>
    service.getCaseSummary(identifierSchema.parse(caseId)),
  );
  handle(IPC_CHANNELS.listSources, window, (caseId: unknown) =>
    service.listSources(identifierSchema.parse(caseId)),
  );
  handle(
    IPC_CHANNELS.listChats,
    window,
    (caseId: unknown, query: unknown = {}) => {
      const parsed = chatQuerySchema.parse(query);
      return service.listChats(identifierSchema.parse(caseId), {
        ...(parsed.search === undefined ? {} : { search: parsed.search }),
        ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
        ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
      });
    },
  );
  handle(
    IPC_CHANNELS.listMessages,
    window,
    (caseId: unknown, query: unknown) => {
      const parsed = messageQuerySchema.parse(query);
      return service.listMessages(identifierSchema.parse(caseId), {
        chatRecordId: parsed.chatRecordId,
        ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
        ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
        ...(parsed.direction === undefined
          ? {}
          : { direction: parsed.direction }),
      });
    },
  );
  handle(
    IPC_CHANNELS.searchMessages,
    window,
    (caseId: unknown, query: unknown) => {
      const parsed = searchQuerySchema.parse(query);
      return service.searchMessages(identifierSchema.parse(caseId), {
        text: parsed.text,
        ...(parsed.chatRecordId === undefined
          ? {}
          : { chatRecordId: parsed.chatRecordId }),
        ...(parsed.sourceId === undefined ? {} : { sourceId: parsed.sourceId }),
        ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
        ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
      });
    },
  );
  handle(IPC_CHANNELS.getIntegrity, window, (caseId: unknown) =>
    service.getIntegrity(identifierSchema.parse(caseId)),
  );
  handle(
    IPC_CHANNELS.getMessageContext,
    window,
    (caseId: unknown, recordId: unknown, radius: unknown) =>
      service.getMessageContext(
        identifierSchema.parse(caseId),
        z.string().min(1).max(240).parse(recordId),
        z.number().int().min(0).max(50).parse(radius),
      ),
  );
}

type _ApiContractMustRemainComplete = WorkstationApi;
void (0 as unknown as _ApiContractMustRemainComplete);
