import { contextBridge, ipcRenderer } from "electron";

import {
  IPC_CHANNELS,
  type ApiResult,
  type WorkstationApi,
} from "../shared/api.js";

const invoke = <T>(channel: string, ...arguments_: unknown[]): Promise<ApiResult<T>> =>
  ipcRenderer.invoke(channel, ...arguments_) as Promise<ApiResult<T>>;

const api: WorkstationApi = {
  cases: {
    list: () => invoke(IPC_CHANNELS.casesList),
    open: (caseId) => invoke(IPC_CHANNELS.casesOpen, caseId),
    create: (input) => invoke(IPC_CHANNELS.casesCreate, input),
    chooseParentDirectory: () => invoke(IPC_CHANNELS.casesChooseParent),
    settings: () => invoke(IPC_CHANNELS.casesSettings),
    openFolder: (input) => invoke(IPC_CHANNELS.casesOpenFolder, input),
  },
  tasks: {
    list: (caseId) => invoke(IPC_CHANNELS.tasksList, caseId),
    assign: (input) => invoke(IPC_CHANNELS.tasksAssign, input),
    disable: (caseId, taskId) => invoke(IPC_CHANNELS.tasksDisable, caseId, taskId),
    chooseUsbRoot: () => invoke(IPC_CHANNELS.tasksChooseUsb),
  },
  results: {
    chooseSource: () => invoke(IPC_CHANNELS.resultsChoose),
    receive: (input) => invoke(IPC_CHANNELS.resultsReceive, input),
  },
  repository: {
    sources: (caseId) => invoke(IPC_CHANNELS.repositorySources, caseId),
    chats: (caseId, query) => invoke(IPC_CHANNELS.repositoryChats, caseId, query),
    messages: (caseId, query) => invoke(IPC_CHANNELS.repositoryMessages, caseId, query),
  },
  attachments: {
    open: (opaqueId) => invoke(IPC_CHANNELS.attachmentsOpen, opaqueId),
  },
  window: {
    minimize: async () => {
      await ipcRenderer.invoke(IPC_CHANNELS.windowMinimize);
    },
    toggleMaximize: async () => {
      await ipcRenderer.invoke(IPC_CHANNELS.windowToggleMaximize);
    },
    close: async () => {
      await ipcRenderer.invoke(IPC_CHANNELS.windowClose);
    },
    isMaximized: () => ipcRenderer.invoke(IPC_CHANNELS.windowIsMaximized) as Promise<boolean>,
    onMaximizedChanged: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, maximized: boolean): void => {
        listener(maximized);
      };
      ipcRenderer.on(IPC_CHANNELS.windowMaximizedChanged, wrapped);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.windowMaximizedChanged, wrapped);
    },
  },
};

contextBridge.exposeInMainWorld("workstation", Object.freeze(api));
