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
  kind: z.string(),
  participantCount: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  lastMessageAtUtc: z.string().nullable(),
  lastMessagePreview: z.string().nullable(),
});

export type ChatSummary = z.infer<typeof chatSummarySchema>;

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
