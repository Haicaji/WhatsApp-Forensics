import { z } from "zod";

export const identifierSchema = z
  .string()
  .min(3)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u);

export const lowercaseIdentifierSchema = z
  .string()
  .min(3)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]*$/u);

export const fingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
export const uuidSchema = z.uuid();

export const cursorPageSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });

export type CursorPage<T> = {
  items: T[];
  nextCursor: string | null;
};

export const caseStatusSchema = z.enum(["open", "archived"]);

export const caseSummarySchema = z.object({
  caseId: identifierSchema,
  name: z.string().min(1).max(200),
  authorizationReference: z.string().min(1).max(240),
  organization: z.string().min(1).max(240),
  description: z.string().max(2000),
  status: caseStatusSchema,
  createdAtUtc: z.iso.datetime(),
  updatedAtUtc: z.iso.datetime(),
  sourceCount: z.number().int().nonnegative(),
  chatCount: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  integrity: z.enum(["empty", "verified", "partial", "failed"]),
});

export type CaseSummary = z.infer<typeof caseSummarySchema>;

export const createCaseInputSchema = z.object({
  caseId: identifierSchema,
  name: z.string().trim().min(1).max(200),
  authorizationReference: z.string().trim().min(1).max(240),
  organization: z.string().trim().min(1).max(240),
  description: z.string().trim().max(2000).default(""),
});

export type CreateCaseInput = z.infer<typeof createCaseInputSchema>;

export const sourceSummarySchema = z.object({
  sourceId: uuidSchema,
  evidenceId: uuidSchema,
  assignmentId: identifierSchema,
  operatorId: lowercaseIdentifierSchema,
  signerFingerprint: fingerprintSchema,
  manifestRootSha256: sha256Schema,
  bagPath: z.string(),
  importedAtUtc: z.iso.datetime(),
  observationStartedAtUtc: z.string(),
  observationEndedAtUtc: z.string(),
  localSnapshot: z.enum(["verified", "partial", "failed"]),
  historyScope: z.string(),
  mediaScope: z.string(),
  messageCount: z.number().int().nonnegative(),
});

export type SourceSummary = z.infer<typeof sourceSummarySchema>;

export const chatSchema = z.object({
  recordId: z.string(),
  sourceId: uuidSchema,
  title: z.string(),
  kind: z.string(),
  unreadCount: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  firstObservedAtUtc: z.string().nullable(),
  lastObservedAtUtc: z.string().nullable(),
  lastMessagePreview: z.string().nullable(),
});

export type Chat = z.infer<typeof chatSchema>;

export const messageFlagsSchema = z.object({
  fromMe: z.boolean(),
  edited: z.boolean(),
  revoked: z.boolean(),
  starred: z.boolean(),
  forwarded: z.boolean(),
});

export const messageSchema = z.object({
  recordId: z.string(),
  sourceId: uuidSchema,
  chatRecordId: z.string(),
  senderRecordId: z.string().nullable(),
  senderDisplayName: z.string().nullable(),
  sentAtUtc: z.string().nullable(),
  kind: z.string(),
  text: z.string().nullable(),
  caption: z.string().nullable(),
  flags: messageFlagsSchema,
  attachmentCount: z.number().int().nonnegative(),
  contentSha256: sha256Schema,
});

export type Message = z.infer<typeof messageSchema>;

export const searchHitSchema = z.object({
  message: messageSchema,
  chatTitle: z.string(),
  snippet: z.string(),
  rank: z.number(),
});

export type SearchHit = z.infer<typeof searchHitSchema>;

export const integritySummarySchema = z.object({
  overall: z.enum(["empty", "verified", "partial", "failed"]),
  sourceCount: z.number().int().nonnegative(),
  trustedSourceCount: z.number().int().nonnegative(),
  totalMessages: z.number().int().nonnegative(),
  unresolvedReferences: z.number().int().nonnegative(),
  sources: z.array(sourceSummarySchema),
  limitations: z.array(z.string()),
});

export type IntegritySummary = z.infer<typeof integritySummarySchema>;

export type ChatQuery = {
  search?: string;
  limit?: number;
  cursor?: string | null;
};

export type MessageQuery = {
  chatRecordId: string;
  limit?: number;
  cursor?: string | null;
  direction?: "forward" | "backward";
};

export type SearchQuery = {
  text: string;
  chatRecordId?: string;
  sourceId?: string;
  limit?: number;
  cursor?: string | null;
};

export const workstationProfileSchema = z.object({
  schemaVersion: z.literal("wafc-workstation-profile/1"),
  workstationId: identifierSchema,
  keyId: identifierSchema,
  publicKeySpkiBase64: z.string().min(1),
  fingerprintSha256: fingerprintSchema,
  createdAtUtc: z.iso.datetime(),
});

export type WorkstationProfile = z.infer<typeof workstationProfileSchema>;

export const initializeWorkstationInputSchema = z.object({
  workstationId: identifierSchema,
  keyId: identifierSchema,
  passphrase: z.string().min(12).max(1024),
  passphraseConfirmation: z.string().min(12).max(1024),
});

export type InitializeWorkstationInput = z.infer<
  typeof initializeWorkstationInputSchema
>;

export const provisionUsbInputSchema = z.object({
  caseId: identifierSchema,
  usbRoot: z.string().min(1).max(1024),
  operator: z.object({
    operatorId: lowercaseIdentifierSchema,
    displayName: z.string().trim().min(1).max(160),
    organization: z.string().trim().min(1).max(240),
    keyId: identifierSchema,
  }),
  assignment: z.object({
    assignmentId: identifierSchema,
    authorizationReference: z.string().trim().min(1).max(240),
    sourceOrganization: z.string().trim().min(1).max(240),
    validFromUtc: z.iso.datetime(),
    validUntilUtc: z.iso.datetime(),
    targetDescription: z.string().trim().min(1).max(500),
  }),
  workstationPassphrase: z.string().min(12).max(1024),
  operatorPassphrase: z.string().min(12).max(1024),
  operatorPassphraseConfirmation: z.string().min(12).max(1024),
});

export type ProvisionUsbInput = z.infer<typeof provisionUsbInputSchema>;

export const provisioningReceiptSchema = z.object({
  schemaVersion: z.literal("wafc-provisioning-receipt/1"),
  bundleId: uuidSchema,
  operatorId: lowercaseIdentifierSchema,
  operatorKeyId: identifierSchema,
  operatorKeyFingerprintSha256: fingerprintSchema,
  workstationKeyFingerprintSha256: fingerprintSchema,
  manifestSha256: sha256Schema,
  assignments: z.array(
    z.object({
      assignmentId: identifierSchema,
      documentSha256: sha256Schema,
    }),
  ),
  provisionedAtUtc: z.iso.datetime(),
  collectorDirectory: z.string().optional(),
});

export type ProvisioningReceipt = z.infer<typeof provisioningReceiptSchema>;

export const importResultSchema = z.object({
  caseId: identifierSchema,
  evidenceId: uuidSchema,
  sourceId: uuidSchema,
  manifestRootSha256: sha256Schema,
  status: z.enum(["imported", "already_imported"]),
  chatCount: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
});

export type ImportResult = z.infer<typeof importResultSchema>;

export const usbIntakeResultSchema = z.object({
  imported: z.array(importResultSchema),
  skipped: z.array(
    z.object({
      path: z.string(),
      reason: z.string(),
    }),
  ),
});

export type UsbIntakeResult = z.infer<typeof usbIntakeResultSchema>;

