import type {
  AssignTaskInput,
  CaseSummary,
  ChatQuery,
  ChatSummary,
  CreateCaseInput,
  CursorPage,
  EvidenceSource,
  MessageQuery,
  MessageView,
  ReceiveInput,
  ReceiveResult,
  SettingsInfo,
  TaskSummary,
} from "@wafc/domain";

export type ApiError = {
  code: string;
  userMessage: string;
  eventId: string;
};

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ApiError };

export type OpenFolderInput =
  | { target: "data" | "defaultCases" }
  | { target: "case"; caseId: string }
  | { target: "task"; caseId: string; taskId: string };

export interface CasesApi {
  list(): Promise<ApiResult<CaseSummary[]>>;
  open(caseId: string): Promise<ApiResult<CaseSummary>>;
  create(input: CreateCaseInput): Promise<ApiResult<CaseSummary>>;
  chooseParentDirectory(): Promise<ApiResult<string | null>>;
  settings(): Promise<ApiResult<SettingsInfo>>;
  openFolder(input: OpenFolderInput): Promise<ApiResult<{ opened: true }>>;
}

export interface TasksApi {
  list(caseId: string): Promise<ApiResult<TaskSummary[]>>;
  assign(input: AssignTaskInput): Promise<ApiResult<TaskSummary>>;
  disable(caseId: string, taskId: string): Promise<ApiResult<TaskSummary>>;
  chooseUsbRoot(): Promise<ApiResult<string | null>>;
}

export interface ResultsApi {
  chooseSource(): Promise<ApiResult<string | null>>;
  receive(input: ReceiveInput): Promise<ApiResult<ReceiveResult[]>>;
}

export interface RepositoryApi {
  sources(caseId: string): Promise<ApiResult<EvidenceSource[]>>;
  chats(caseId: string, query: ChatQuery): Promise<ApiResult<CursorPage<ChatSummary>>>;
  messages(caseId: string, query: MessageQuery): Promise<ApiResult<CursorPage<MessageView>>>;
}

export interface AttachmentsApi {
  open(opaqueId: string): Promise<ApiResult<{ opened: true }>>;
}

export interface WindowApi {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  onMaximizedChanged(listener: (maximized: boolean) => void): () => void;
}

export interface WorkstationApi {
  cases: CasesApi;
  tasks: TasksApi;
  results: ResultsApi;
  repository: RepositoryApi;
  attachments: AttachmentsApi;
  window: WindowApi;
}

export const IPC_CHANNELS = {
  casesList: "wafc:cases:list",
  casesOpen: "wafc:cases:open",
  casesCreate: "wafc:cases:create",
  casesChooseParent: "wafc:cases:choose-parent",
  casesSettings: "wafc:cases:settings",
  casesOpenFolder: "wafc:cases:open-folder",
  tasksList: "wafc:tasks:list",
  tasksAssign: "wafc:tasks:assign",
  tasksDisable: "wafc:tasks:disable",
  tasksChooseUsb: "wafc:tasks:choose-usb",
  resultsChoose: "wafc:results:choose",
  resultsReceive: "wafc:results:receive",
  repositorySources: "wafc:repository:sources",
  repositoryChats: "wafc:repository:chats",
  repositoryMessages: "wafc:repository:messages",
  attachmentsOpen: "wafc:attachments:open",
  windowMinimize: "wafc:window:minimize",
  windowToggleMaximize: "wafc:window:toggle-maximize",
  windowClose: "wafc:window:close",
  windowIsMaximized: "wafc:window:is-maximized",
  windowMaximizedChanged: "wafc:window:maximized-changed",
} as const;
