import type {
  CaseSummary,
  Chat,
  ChatQuery,
  CreateCaseInput,
  CursorPage,
  ImportResult,
  InitializeWorkstationInput,
  InspectUsbSoftwareInput,
  IntegritySummary,
  Message,
  MessageQuery,
  ProvisionUsbInput,
  ProvisioningReceipt,
  SearchHit,
  SearchQuery,
  SourceSummary,
  UsbIntakeResult,
  UsbSoftwareInspection,
  UsbSoftwareUpdateResult,
  UpdateUsbSoftwareInput,
  WorkstationProfile,
} from "@wafc/domain";

export type ApiError = {
  code: string;
  message: string;
};

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ApiError };

export type WorkstationStatus = {
  initialized: boolean;
  profile: WorkstationProfile | null;
  cases: CaseSummary[];
};

export type AssignmentSummary = {
  assignmentId: string;
  caseId: string;
  operatorId: string;
  operatorKeyId: string;
  operatorFingerprint: string;
  bundleId: string;
  authorizationReference: string;
  validFromUtc: string;
  validUntilUtc: string;
};

export type ProvisionUsbResult = ProvisioningReceipt & {
  collectorDirectory: string;
  releasePublishable: boolean;
};

export interface WorkstationApi {
  status(): Promise<ApiResult<WorkstationStatus>>;
  initializeWorkstation(
    input: InitializeWorkstationInput,
  ): Promise<ApiResult<WorkstationProfile>>;
  listCases(): Promise<ApiResult<CaseSummary[]>>;
  createCase(input: CreateCaseInput): Promise<ApiResult<CaseSummary>>;
  listAssignments(caseId: string): Promise<ApiResult<AssignmentSummary[]>>;
  chooseUsbRoot(): Promise<ApiResult<string | null>>;
  chooseEvidenceBag(): Promise<ApiResult<string | null>>;
  provisionUsb(input: ProvisionUsbInput): Promise<ApiResult<ProvisionUsbResult>>;
  inspectUsbSoftware(
    input: InspectUsbSoftwareInput,
  ): Promise<ApiResult<UsbSoftwareInspection>>;
  updateUsbSoftware(
    input: UpdateUsbSoftwareInput,
  ): Promise<ApiResult<UsbSoftwareUpdateResult>>;
  intakeUsb(caseId: string, usbRoot: string): Promise<ApiResult<UsbIntakeResult>>;
  intakeUsbAutomatically(usbRoot: string): Promise<ApiResult<UsbIntakeResult>>;
  importEvidence(caseId: string, bagPath: string): Promise<ApiResult<ImportResult>>;
  getCaseSummary(caseId: string): Promise<ApiResult<CaseSummary>>;
  listSources(caseId: string): Promise<ApiResult<SourceSummary[]>>;
  listChats(
    caseId: string,
    query?: ChatQuery,
  ): Promise<ApiResult<CursorPage<Chat>>>;
  listMessages(
    caseId: string,
    query: MessageQuery,
  ): Promise<ApiResult<CursorPage<Message>>>;
  searchMessages(
    caseId: string,
    query: SearchQuery,
  ): Promise<ApiResult<CursorPage<SearchHit>>>;
  getIntegrity(caseId: string): Promise<ApiResult<IntegritySummary>>;
  getMessageContext(
    caseId: string,
    recordId: string,
    radius: number,
  ): Promise<ApiResult<Message[]>>;
}

export const IPC_CHANNELS = {
  status: "wafc:status",
  initializeWorkstation: "wafc:initialize-workstation",
  listCases: "wafc:cases:list",
  createCase: "wafc:cases:create",
  listAssignments: "wafc:assignments:list",
  chooseUsbRoot: "wafc:dialog:usb-root",
  chooseEvidenceBag: "wafc:dialog:evidence-bag",
  provisionUsb: "wafc:usb:provision",
  inspectUsbSoftware: "wafc:usb:software:inspect",
  updateUsbSoftware: "wafc:usb:software:update",
  intakeUsb: "wafc:usb:intake",
  intakeUsbAutomatically: "wafc:usb:intake-automatic",
  importEvidence: "wafc:evidence:import",
  getCaseSummary: "wafc:repository:case-summary",
  listSources: "wafc:repository:sources",
  listChats: "wafc:repository:chats",
  listMessages: "wafc:repository:messages",
  searchMessages: "wafc:repository:search",
  getIntegrity: "wafc:repository:integrity",
  getMessageContext: "wafc:repository:message-context",
} as const;
