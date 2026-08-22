import type {
  CaseManifest,
  CollectionStatus,
  FieldCollectorSchemaVersion,
} from "./internal-types.js";

export type NewSourceRecord = {
  sourceId: string;
  specimenName: string;
  schemaVersion: FieldCollectorSchemaVersion;
  collectionStatus: CollectionStatus;
  taskId: string | null;
  sessionId: string;
  importFingerprint: string;
  rawRelativePath: string;
  importedAtUtc: string;
  startedAtUtc: string | null;
  finishedAtUtc: string | null;
  warning: string | null;
};

export type NewChatRecord = {
  sourceId: string;
  nativeId: string;
  title: string;
  phoneNumber: string | null;
  formattedPhoneNumber: string | null;
  kind: string;
  participantCount: number;
};

export type ChatPhoneIdentity = {
  nativeId: string;
  phoneNumber: string | null;
  formattedPhoneNumber: string | null;
};

export type NewMessageRecord = {
  sourceId: string;
  nativeId: string;
  chatNativeId: string;
  sortIndex: number;
  senderId: string | null;
  senderDisplayName: string | null;
  recipientId: string | null;
  fromMe: boolean;
  timestampUtc: string | null;
  type: string;
  text: string | null;
  caption: string | null;
  quotedMessageId: string | null;
  isForwarded: boolean;
  isStarred: boolean;
  isRevoked: boolean;
  acknowledgement: string | null;
};

export type NewAttachmentRecord = {
  opaqueId: string;
  sourceId: string;
  messageNativeId: string;
  relativePath: string | null;
  kind: "image" | "audio" | "video" | "document" | "other";
  status: "available" | "missing" | "failed";
  mimeType: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  failureReason: string | null;
};

export type AssetLocation = {
  sourceId: string;
  rawRelativePath: string;
  attachmentRelativePath: string | null;
  status: "available" | "missing" | "failed";
  mimeType: string | null;
  fileName: string | null;
};

export type RepositoryCounts = {
  sourceCount: number;
  taskCount: number;
  chatCount: number;
  messageCount: number;
};

export type { CaseManifest };

export type { CollectionStatus, FieldCollectorSchemaVersion } from "./internal-types.js";
