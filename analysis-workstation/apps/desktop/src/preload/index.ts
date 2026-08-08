import { contextBridge, ipcRenderer } from "electron";

import {
  IPC_CHANNELS,
  type WorkstationApi,
} from "../shared/api";

const api: WorkstationApi = {
  status: () => ipcRenderer.invoke(IPC_CHANNELS.status),
  initializeWorkstation: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.initializeWorkstation, input),
  listCases: () => ipcRenderer.invoke(IPC_CHANNELS.listCases),
  createCase: (input) => ipcRenderer.invoke(IPC_CHANNELS.createCase, input),
  listAssignments: (caseId) =>
    ipcRenderer.invoke(IPC_CHANNELS.listAssignments, caseId),
  chooseUsbRoot: () => ipcRenderer.invoke(IPC_CHANNELS.chooseUsbRoot),
  chooseEvidenceBag: () => ipcRenderer.invoke(IPC_CHANNELS.chooseEvidenceBag),
  provisionUsb: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.provisionUsb, input),
  intakeUsb: (caseId, usbRoot) =>
    ipcRenderer.invoke(IPC_CHANNELS.intakeUsb, caseId, usbRoot),
  intakeUsbAutomatically: (usbRoot) =>
    ipcRenderer.invoke(IPC_CHANNELS.intakeUsbAutomatically, usbRoot),
  importEvidence: (caseId, bagPath) =>
    ipcRenderer.invoke(IPC_CHANNELS.importEvidence, caseId, bagPath),
  getCaseSummary: (caseId) =>
    ipcRenderer.invoke(IPC_CHANNELS.getCaseSummary, caseId),
  listSources: (caseId) =>
    ipcRenderer.invoke(IPC_CHANNELS.listSources, caseId),
  listChats: (caseId, query) =>
    ipcRenderer.invoke(IPC_CHANNELS.listChats, caseId, query ?? {}),
  listMessages: (caseId, query) =>
    ipcRenderer.invoke(IPC_CHANNELS.listMessages, caseId, query),
  searchMessages: (caseId, query) =>
    ipcRenderer.invoke(IPC_CHANNELS.searchMessages, caseId, query),
  getIntegrity: (caseId) =>
    ipcRenderer.invoke(IPC_CHANNELS.getIntegrity, caseId),
  getMessageContext: (caseId, recordId, radius) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.getMessageContext,
      caseId,
      recordId,
      radius,
    ),
};

contextBridge.exposeInMainWorld("wafc", api);
