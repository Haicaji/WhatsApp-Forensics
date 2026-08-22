import { z } from "zod";

export const uuidSchema = z.uuid();
export const isoDateTimeSchema = z.iso.datetime({ offset: true });
export const nonBlankSchema = z.string().trim().min(1);

export type CursorPage<T> = {
  items: T[];
  nextCursor: string | null;
};

export const caseSummarySchema = z.object({
  caseId: uuidSchema,
  name: z.string().min(1).max(200),
  path: z.string().min(1),
  createdAtUtc: isoDateTimeSchema,
  updatedAtUtc: isoDateTimeSchema,
  lastOpenedAtUtc: isoDateTimeSchema.nullable(),
  sourceCount: z.number().int().nonnegative(),
  taskCount: z.number().int().nonnegative(),
  chatCount: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
});

export type CaseSummary = z.infer<typeof caseSummarySchema>;

export const createCaseInputSchema = z.object({
  name: z.string().trim().min(1, "请输入案件名称").max(200),
  parentDirectory: z.string().trim().min(1, "请选择案件保存位置"),
});

export type CreateCaseInput = z.infer<typeof createCaseInputSchema>;

export const caseManifestSchema = z.object({
  schemaVersion: z.literal("wafc-analysis-case/1"),
  caseId: uuidSchema,
  name: z.string().min(1).max(200),
  createdAtUtc: isoDateTimeSchema,
});

export type CaseManifest = z.infer<typeof caseManifestSchema>;

export const taskStatusSchema = z.enum(["active", "disabled"]);

export const taskSummarySchema = z.object({
  taskId: uuidSchema,
  caseId: uuidSchema,
  taskName: z.string().min(1).max(200),
  usbRoot: z.string().min(1),
  collectorDirectory: z.string().min(1),
  createdAtUtc: isoDateTimeSchema,
  status: taskStatusSchema,
  disabledAtUtc: isoDateTimeSchema.nullable(),
  receivedCount: z.number().int().nonnegative(),
});

export type TaskSummary = z.infer<typeof taskSummarySchema>;

export const assignTaskInputSchema = z.object({
  caseId: uuidSchema,
  taskName: z.string().trim().min(1, "请输入任务名称").max(200),
  usbRoot: z.string().trim().min(1, "请选择 U 盘根目录"),
});

export type AssignTaskInput = z.infer<typeof assignTaskInputSchema>;

export const portableTaskSchema = z.object({
  schemaVersion: z.literal("wafc-portable-task/1"),
  taskId: uuidSchema,
  caseId: uuidSchema,
  caseName: z.string().min(1).max(200),
  taskName: z.string().min(1).max(200),
  createdAtUtc: isoDateTimeSchema,
  resultDirectory: z.literal("results"),
});

export type PortableTask = z.infer<typeof portableTaskSchema>;

export const collectionStatusSchema = z.enum(["complete", "cancelled", "failed"]);
export const fieldCollectorSchemaVersionSchema = z.enum([
  "field-collector-session/5",
  "field-collector-session/6",
]);

export const evidenceSourceSchema = z.object({
  sourceId: uuidSchema,
  specimenName: z.string().min(1).max(300),
  schemaVersion: fieldCollectorSchemaVersionSchema,
  collectionStatus: collectionStatusSchema,
  taskId: uuidSchema.nullable(),
  sessionId: z.string().min(1),
  importedAtUtc: isoDateTimeSchema,
  startedAtUtc: z.string().nullable(),
  finishedAtUtc: z.string().nullable(),
  chatCount: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  mediaCount: z.number().int().nonnegative(),
  warning: z.string().nullable(),
});

export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;

export const chatSummarySchema = z.object({
  sourceId: uuidSchema,
  nativeId: z.string().min(1),
  title: z.string().min(1),
  phoneNumber: z.string().nullable(),
  formattedPhoneNumber: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  kind: z.string(),
  participantCount: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  mediaCount: z.number().int().nonnegative(),
  starredMessageCount: z.number().int().nonnegative(),
  lastMessageAtUtc: z.string().nullable(),
  lastMessagePreview: z.string().nullable(),
  community: z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    avatarUrl: z.string().nullable(),
    role: z.enum(["announcement", "group"]),
  }).nullable(),
});

export type ChatSummary = z.infer<typeof chatSummarySchema>;

export const sourceFeatureAvailabilitySchema = z.object({
  status: z.enum(["available", "empty", "unavailable", "error"]),
  reason: z.string().nullable(),
  truncated: z.boolean(),
});

export type SourceFeatureAvailability = z.infer<typeof sourceFeatureAvailabilitySchema>;

export const sourceAccountViewSchema = z.object({
  nativeId: z.string().nullable(),
  displayName: z.string().nullable(),
  about: z.string().nullable(),
  formattedPhoneNumber: z.string().nullable(),
});

export type SourceAccountView = z.infer<typeof sourceAccountViewSchema>;

export const callEvidenceViewSchema = z.object({
  id: z.string().min(1),
  peerId: z.string().nullable(),
  title: z.string().min(1),
  timestampUtc: z.string().nullable(),
  durationSeconds: z.number().nonnegative().nullable(),
  direction: z.enum(["incoming", "outgoing", "unknown"]),
  isVideo: z.boolean(),
  isGroup: z.boolean(),
  state: z.string().nullable(),
});

export type CallEvidenceView = z.infer<typeof callEvidenceViewSchema>;

export const statusEvidenceViewSchema = z.object({
  id: z.string().min(1),
  contactId: z.string().nullable(),
  title: z.string().min(1),
  timestampUtc: z.string().nullable(),
  expiresAtUtc: z.string().nullable(),
  itemCount: z.number().int().nonnegative(),
  preview: z.string().nullable(),
});

export type StatusEvidenceView = z.infer<typeof statusEvidenceViewSchema>;

export const channelMessageViewSchema = z.object({
  id: z.string().min(1),
  timestampUtc: z.string().nullable(),
  senderId: z.string().nullable(),
  type: z.string().min(1),
  text: z.string().nullable(),
  caption: z.string().nullable(),
  isForwarded: z.boolean(),
  isStarred: z.boolean(),
  isRevoked: z.boolean(),
  attachments: z.array(z.lazy(() => attachmentViewSchema)),
});

export type ChannelMessageView = z.infer<typeof channelMessageViewSchema>;

export const channelEvidenceViewSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  avatarUrl: z.string().nullable(),
  description: z.string().nullable(),
  subscribersCount: z.number().nonnegative().nullable(),
  unreadCount: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  lastEventAtUtc: z.string().nullable(),
  lastEventPreview: z.string().nullable(),
  historyComplete: z.boolean().nullable(),
  messages: z.array(channelMessageViewSchema),
  messagesTruncated: z.boolean(),
});

export type ChannelEvidenceView = z.infer<typeof channelEvidenceViewSchema>;

export const communityEvidenceViewSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable(),
  createdAtUtc: z.string().nullable(),
  childGroups: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    role: z.enum(["announcement", "group"]),
  })),
});

export type CommunityEvidenceView = z.infer<typeof communityEvidenceViewSchema>;

export const sourceWorkspaceViewSchema = z.object({
  sourceId: uuidSchema,
  visibleChatCount: z.number().int().nonnegative(),
  account: sourceAccountViewSchema,
  calls: z.array(callEvidenceViewSchema),
  statuses: z.array(statusEvidenceViewSchema),
  channels: z.array(channelEvidenceViewSchema),
  communities: z.array(communityEvidenceViewSchema),
  availability: z.object({
    calls: sourceFeatureAvailabilitySchema,
    statuses: sourceFeatureAvailabilitySchema,
    channels: sourceFeatureAvailabilitySchema,
    communities: sourceFeatureAvailabilitySchema,
  }),
});

export type SourceWorkspaceView = z.infer<typeof sourceWorkspaceViewSchema>;

export const attachmentKindSchema = z.enum([
  "image",
  "audio",
  "video",
  "document",
  "other",
]);

export const attachmentStatusSchema = z.enum(["available", "missing", "failed"]);

export const attachmentViewSchema = z.object({
  opaqueId: uuidSchema,
  sourceId: uuidSchema,
  messageNativeId: z.string().min(1),
  kind: attachmentKindSchema,
  status: attachmentStatusSchema,
  mimeType: z.string().nullable(),
  fileName: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  url: z.string().nullable(),
  failureReason: z.string().nullable(),
});

export type AttachmentView = z.infer<typeof attachmentViewSchema>;

export const messageViewSchema = z.object({
  sourceId: uuidSchema,
  nativeId: z.string().min(1),
  chatNativeId: z.string().min(1),
  senderId: z.string().nullable(),
  senderDisplayName: z.string().nullable(),
  recipientId: z.string().nullable(),
  fromMe: z.boolean(),
  timestampUtc: z.string().nullable(),
  type: z.string(),
  text: z.string().nullable(),
  caption: z.string().nullable(),
  quotedMessageId: z.string().nullable(),
  isForwarded: z.boolean(),
  isStarred: z.boolean(),
  isRevoked: z.boolean(),
  acknowledgement: z.string().nullable(),
  attachments: z.array(attachmentViewSchema),
});

export type MessageView = z.infer<typeof messageViewSchema>;

export const chatQuerySchema = z.object({
  sourceId: uuidSchema,
  search: z.string().trim().max(200).default(""),
  cursor: z.string().nullable().default(null),
  limit: z.number().int().min(1).max(200).default(80),
});

export type ChatQuery = z.infer<typeof chatQuerySchema>;

export const messageQuerySchema = z.object({
  sourceId: uuidSchema,
  chatNativeId: z.string().min(1),
  beforeCursor: z.string().nullable().default(null),
  limit: z.number().int().min(1).max(200).default(100),
});

export type MessageQuery = z.infer<typeof messageQuerySchema>;

export const offlinePreviewExportInputSchema = z.object({
  caseId: uuidSchema,
  sourceId: uuidSchema,
  targetPath: z.string().trim().min(1, "请选择离线预览保存位置"),
});

export type OfflinePreviewExportInput = z.infer<typeof offlinePreviewExportInputSchema>;

export const offlinePreviewExportResultSchema = z.object({
  path: z.string().min(1),
  fileName: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
});

export type OfflinePreviewExportResult = z.infer<typeof offlinePreviewExportResultSchema>;

export const receiveResultSchema = z.object({
  sessionPath: z.string(),
  accepted: z.boolean(),
  deduplicated: z.boolean(),
  source: evidenceSourceSchema.nullable(),
  errorCode: z.string().nullable(),
  userMessage: z.string(),
});

export type ReceiveResult = z.infer<typeof receiveResultSchema>;

export const receiveInputSchema = z.object({
  caseId: uuidSchema,
  selectedPath: z.string().trim().min(1),
});

export type ReceiveInput = z.infer<typeof receiveInputSchema>;

export const settingsInfoSchema = z.object({
  dataDirectory: z.string().min(1),
  defaultCasesDirectory: z.string().min(1),
  catalogPath: z.string().min(1),
});

export type SettingsInfo = z.infer<typeof settingsInfoSchema>;

export const folderTargetSchema = z.enum(["data", "defaultCases", "case", "task"]);
export type FolderTarget = z.infer<typeof folderTargetSchema>;
