import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { finished } from "node:stream/promises";

import type { EvidenceSource, ReceiveResult } from "@wafc/domain";
import { portableTaskSchema } from "@wafc/domain";
import {
  CaseRepository,
  type SessionImportTransaction,
} from "@wafc/evidence-repository/node";
import { parse } from "csv-parse";
import { z } from "zod";

import { WorkstationError, toWorkstationError } from "./errors.js";
import {
  assertSafeDirectory,
  assertSafeRegularFile,
  copySafeTree,
  fingerprintFiles,
  safeRemoveCreatedDirectory,
  walkSafeFiles,
} from "./safe-files.js";
import { assertPathInside, isPathInside, toPortableRelativePath } from "./paths.js";

const MAX_JSON_BYTES = 128 * 1024 * 1024;
const REQUIRED_MESSAGE_HEADERS = [
  "id",
  "chatId",
  "senderId",
  "recipientId",
  "fromMe",
  "timestamp",
  "type",
  "text",
  "caption",
  "quotedMessageId",
  "isForwarded",
  "isStarred",
  "isRevoked",
  "acknowledgement",
  "hasMedia",
  "mediaMimeType",
  "mediaFileName",
  "mediaSize",
] as const;

const manifestBaseSchema = z.object({
  schemaVersion: z.enum(["field-collector-session/5", "field-collector-session/6"]),
  status: z.enum(["complete", "cancelled", "failed"]),
  startedAt: z.string().nullable().optional(),
  finishedAt: z.string().nullable().optional(),
  evidenceItem: z.object({ name: z.string().trim().min(1).max(300) }),
  chatCount: z.number().int().nonnegative().optional(),
});

const v6TaskReferenceSchema = portableTaskSchema.omit({ resultDirectory: true });

const manifestSchema = z.discriminatedUnion("schemaVersion", [
  manifestBaseSchema.extend({
    schemaVersion: z.literal("field-collector-session/5"),
  }),
  manifestBaseSchema.extend({
    schemaVersion: z.literal("field-collector-session/6"),
    sessionId: z.uuid(),
    task: v6TaskReferenceSchema,
  }),
]);

type SessionManifest = z.infer<typeof manifestSchema>;
type CsvRow = Record<string, string>;
type JsonObject = Record<string, unknown>;

type MediaIndexRecord = {
  messageId: string;
  relativePath: string | null;
  mimeType: string | null;
  originalFileName: string | null;
  byteLength: number | null;
  type: string | null;
  status: string;
  failureReason: string | null;
};

export class ResultImporter {
  readonly #caseId: string;
  readonly #caseRoot: string;
  readonly #repository: CaseRepository;

  constructor(caseId: string, caseRoot: string, repository: CaseRepository) {
    this.#caseId = caseId;
    this.#caseRoot = resolve(caseRoot);
    this.#repository = repository;
  }

  async receive(selectedPath: string): Promise<ReceiveResult[]> {
    const sessions = discoverSessionDirectories(selectedPath);
    const results: ReceiveResult[] = [];
    for (const session of sessions) {
      try {
        results.push(await this.#receiveOne(session));
      } catch (error) {
        const workstationError = toWorkstationError(error);
        results.push({
          sessionPath: session,
          accepted: false,
          deduplicated: false,
          source: null,
          errorCode: workstationError.code,
          userMessage: workstationError.userMessage,
        });
      }
    }
    return results;
  }

  async #receiveOne(sessionRoot: string): Promise<ReceiveResult> {
    assertSafeDirectory(sessionRoot, "采集 session 目录");
    walkSafeFiles(sessionRoot);
    const manifest = manifestSchema.parse(readJsonObject(join(sessionRoot, "manifest.json")));
    validateAccount(join(sessionRoot, "account.json"));
    const chatDirectories = discoverChatDirectories(sessionRoot);
    validateChatStructure(chatDirectories);

    let taskId: string | null = null;
    let sessionId: string;
    let fingerprint: string;
    if (manifest.schemaVersion === "field-collector-session/6") {
      if (manifest.task.caseId !== this.#caseId) {
        throw new WorkstationError(
          "CASE_MISMATCH",
          `结果属于案件“${manifest.task.caseName}”，不能接收到当前案件。`,
        );
      }
      const task = this.#repository.getTask(manifest.task.taskId);
      if (task === null) {
        throw new WorkstationError("TASK_NOT_FOUND", "当前案件中没有与结果匹配的任务。");
      }
      if (task.status !== "active") {
        throw new WorkstationError("TASK_DISABLED", `任务“${task.taskName}”已停用，不能接收新的结果。`);
      }
      const existing = this.#repository.findSourceByTaskSession(
        manifest.task.taskId,
        manifest.sessionId,
      );
      if (existing !== null) return duplicateResult(sessionRoot, existing);
      taskId = manifest.task.taskId;
      sessionId = manifest.sessionId;
      fingerprint = technicalV6Fingerprint(taskId, sessionId);
    } else {
      fingerprint = await fingerprintV5Session(sessionRoot);
      const existing = this.#repository.findSourceByFingerprint(fingerprint);
      if (existing !== null) return duplicateResult(sessionRoot, existing);
      sessionId = `legacy-${fingerprint.slice("sha256:".length, "sha256:".length + 24)}`;
    }

    const sourceId = randomUUID();
    const sourcesRoot = join(this.#caseRoot, "sources");
    mkdirSync(sourcesRoot, { recursive: true });
    const finalSourceRoot = join(sourcesRoot, sourceId);
    const stagingSourceRoot = join(sourcesRoot, `.${sourceId}.partial`);
    const stagingRawRoot = join(stagingSourceRoot, "raw");
    let promoted = false;
    let transaction: SessionImportTransaction | null = null;
    try {
      mkdirSync(stagingSourceRoot, { recursive: false });
      await copySafeTree(sessionRoot, stagingRawRoot);
      walkSafeFiles(stagingRawRoot);
      if (manifest.schemaVersion === "field-collector-session/5") {
        const copiedFingerprint = await fingerprintV5Session(stagingRawRoot);
        if (copiedFingerprint !== fingerprint) {
          throw new WorkstationError(
            "SOURCE_CHANGED_DURING_COPY",
            "采集结果在复制期间发生变化，本次接收已回滚。",
          );
        }
      }

      const warning = manifest.status === "complete"
        ? null
        : manifest.status === "cancelled"
          ? "本次采集已取消，展示的是已保存的部分结果。"
          : "本次采集标记为失败，展示的是可解析的部分结果。";
      const rawRelativePath = toPortableRelativePath(
        relative(this.#caseRoot, join(finalSourceRoot, "raw")),
      );
      transaction = this.#repository.beginSessionImport({
        sourceId,
        specimenName: manifest.evidenceItem.name,
        schemaVersion: manifest.schemaVersion,
        collectionStatus: manifest.status,
        taskId,
        sessionId,
        importFingerprint: fingerprint,
        rawRelativePath,
        importedAtUtc: new Date().toISOString(),
        startedAtUtc: manifest.startedAt ?? null,
        finishedAtUtc: manifest.finishedAt ?? null,
        warning,
      });
      await parseSessionIntoRepository(stagingRawRoot, sourceId, chatDirectoriesFromCopy(
        stagingRawRoot,
        chatDirectories,
      ), transaction);
      renameSync(stagingSourceRoot, finalSourceRoot);
      promoted = true;
      transaction.commit();
      transaction = null;
      const source = this.#repository.getSource(sourceId);
      if (source === null) throw new Error("imported source was not found after commit");
      return {
        sessionPath: sessionRoot,
        accepted: true,
        deduplicated: false,
        source,
        errorCode: null,
        userMessage: warning ?? `已接收检材“${source.specimenName}”。`,
      };
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      try {
        transaction?.rollback();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      try {
        if (promoted && existsSync(finalSourceRoot)) {
          safeRemoveCreatedDirectory(sourcesRoot, finalSourceRoot);
        }
      } catch (cleanupError) {
        rollbackErrors.push(cleanupError);
      }
      try {
        if (existsSync(stagingSourceRoot)) {
          safeRemoveCreatedDirectory(sourcesRoot, stagingSourceRoot);
        }
      } catch (cleanupError) {
        rollbackErrors.push(cleanupError);
      }
      if (rollbackErrors.length > 0) {
        const primary = toWorkstationError(error);
        const details = rollbackErrors.map(errorMessage).join("；");
        throw new WorkstationError(
          primary.code,
          `${primary.userMessage}（临时副本清理未完成：${details}）`,
          error,
        );
      }
      throw error;
    }
  }
}

export function discoverSessionDirectories(selectedPath: string): string[] {
  const selected = resolve(selectedPath);
  assertSafeDirectory(selected, "所选目录");
  if (existsSync(join(selected, "manifest.json"))) return [selected];

  const usbResults = join(selected, "Field Collector", "results");
  const collectorResults = basename(selected).toLocaleLowerCase("en-US") === "field collector"
    ? join(selected, "results")
    : "";
  const resultsRoot = existsSync(usbResults)
    ? usbResults
    : collectorResults !== "" && existsSync(collectorResults)
      ? collectorResults
      : null;
  if (resultsRoot === null) {
    throw new WorkstationError(
      "RESULTS_NOT_FOUND",
      "所选目录既不是采集 session，也不包含 Field Collector/results。",
    );
  }
  assertSafeDirectory(resultsRoot, "results 目录");
  const sessions = readdirSync(resultsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(resultsRoot, entry.name))
    .filter((path) => existsSync(join(path, "manifest.json")))
    .sort((left, right) => left.localeCompare(right, "en"));
  if (sessions.length === 0) {
    throw new WorkstationError("NO_SESSIONS", "results 目录中没有可接收的采集 session。");
  }
  return sessions;
}

function discoverChatDirectories(sessionRoot: string): string[] {
  const chatsRoot = join(sessionRoot, "chats");
  if (!existsSync(chatsRoot)) {
    throw new WorkstationError("CHAT_DIRECTORY_MISSING", "采集结果缺少 chats 目录。");
  }
  assertSafeDirectory(chatsRoot, "chats 目录");
  return readdirSync(chatsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(chatsRoot, entry.name))
    .sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true }));
}

function validateChatStructure(chatDirectories: readonly string[]): void {
  for (const directory of chatDirectories) {
    assertSafeDirectory(directory, "会话目录");
    for (const required of ["chat.json", "messages.csv"]) {
      const path = join(directory, required);
      if (!existsSync(path)) {
        throw new WorkstationError("CHAT_FILE_MISSING", `会话缺少 ${required}：${directory}`);
      }
      assertSafeRegularFile(path, required);
    }
    const chat = readJsonObject(join(directory, "chat.json"));
    if (typeof chat.id !== "string" || chat.id.trim() === "") {
      throw new WorkstationError("CHAT_INVALID", `chat.json 缺少有效 id：${directory}`);
    }
  }
}

function chatDirectoriesFromCopy(
  copiedRoot: string,
  originalDirectories: readonly string[],
): string[] {
  return originalDirectories.map((directory) => {
    const name = basename(directory);
    const copied = join(copiedRoot, "chats", name);
    assertPathInside(copiedRoot, copied, "复制后的会话目录");
    return copied;
  });
}

function validateAccount(path: string): void {
  const account = readJsonObject(path);
  if (Array.isArray(account)) {
    throw new WorkstationError("ACCOUNT_INVALID", "account.json 必须是 JSON 对象。");
  }
}

function readJsonObject(path: string): JsonObject {
  if (!existsSync(path)) {
    throw new WorkstationError("JSON_FILE_MISSING", `结果缺少 ${basename(path)}。`);
  }
  assertSafeRegularFile(path, basename(path));
  const size = statSync(path).size;
  if (size > MAX_JSON_BYTES) {
    throw new WorkstationError("JSON_TOO_LARGE", `${basename(path)} 超出结构校验大小上限。`);
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new WorkstationError("JSON_INVALID", `${basename(path)} 不是有效 JSON。`, error);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkstationError("JSON_INVALID", `${basename(path)} 必须是 JSON 对象。`);
  }
  return value as JsonObject;
}

function readJsonArray(path: string): unknown[] {
  if (!existsSync(path)) return [];
  assertSafeRegularFile(path, basename(path));
  if (statSync(path).size > MAX_JSON_BYTES) {
    throw new WorkstationError("JSON_TOO_LARGE", `${basename(path)} 超出结构校验大小上限。`);
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new WorkstationError("JSON_INVALID", `${basename(path)} 不是有效 JSON。`, error);
  }
  if (!Array.isArray(value)) {
    throw new WorkstationError("JSON_INVALID", `${basename(path)} 必须是 JSON 数组。`);
  }
  return value;
}

async function fingerprintV5Session(sessionRoot: string): Promise<string> {
  const files = walkSafeFiles(sessionRoot).filter((path) => {
    const relativePath = toPortableRelativePath(relative(sessionRoot, path));
    return (
      relativePath === "manifest.json" ||
      relativePath === "account.json" ||
      relativePath === "media/index.json" ||
      relativePath.endsWith("/chat.json") ||
      relativePath.endsWith("/messages.csv") ||
      relativePath.endsWith("/media/index.json")
    );
  });
  if (files.length < 2) {
    throw new WorkstationError("FINGERPRINT_INPUT_MISSING", "v5 结果缺少生成导入指纹所需的文件。");
  }
  return fingerprintFiles(sessionRoot, files);
}

function technicalV6Fingerprint(taskId: string, sessionId: string): string {
  return `sha256:${createHash("sha256").update(`v6:${taskId}:${sessionId}`).digest("hex")}`;
}

function duplicateResult(sessionPath: string, source: EvidenceSource): ReceiveResult {
  return {
    sessionPath,
    accepted: true,
    deduplicated: true,
    source,
    errorCode: null,
    userMessage: `检材“${source.specimenName}”已经接收，本次未重复复制。`,
  };
}

async function parseSessionIntoRepository(
  sessionRoot: string,
  sourceId: string,
  chatDirectories: readonly string[],
  transaction: SessionImportTransaction,
): Promise<void> {
  const contacts = await readContactNames(join(sessionRoot, "contacts.csv"));
  for (const chatDirectory of chatDirectories) {
    const chat = readJsonObject(join(chatDirectory, "chat.json"));
    const nativeId = String(chat.id);
    const title = firstText(chat.title, chat.contactName, chat.formattedPhoneNumber, nativeId);
    const kind = typeof chat.kind === "string"
      ? chat.kind
      : chat.isGroup === true
        ? "group"
        : "chat";
    const participantCount = await countCsvRecords(join(chatDirectory, "participants.csv"));
    transaction.insertChat({
      sourceId,
      nativeId,
      title,
      kind,
      participantCount,
    });
    const mediaByMessage = readMediaIndex(join(chatDirectory, "media", "index.json"));
    await parseMessageCsv(
      join(chatDirectory, "messages.csv"),
      sourceId,
      nativeId,
      sessionRoot,
      contacts,
      mediaByMessage,
      transaction,
    );
  }
}

async function readContactNames(path: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (!existsSync(path)) return names;
  await parseCsv(path, ["id", "displayName"], (row) => {
    const displayName = firstTextOrNull(
      row.displayName,
      row.savedName,
      row.pushName,
      row.name,
      row.formattedPhoneNumber,
    );
    if (displayName === null) return;
    for (const id of [row.id, row.lidId, row.phoneId]) {
      if (id?.trim()) names.set(id, displayName);
    }
  });
  return names;
}

async function countCsvRecords(path: string): Promise<number> {
  if (!existsSync(path)) return 0;
  let count = 0;
  await parseCsv(path, [], () => {
    count += 1;
  });
  return count;
}

async function parseMessageCsv(
  path: string,
  sourceId: string,
  fallbackChatId: string,
  sessionRoot: string,
  contacts: ReadonlyMap<string, string>,
  mediaByMessage: ReadonlyMap<string, MediaIndexRecord[]>,
  transaction: SessionImportTransaction,
): Promise<void> {
  let sortIndex = 0;
  await parseCsv(path, REQUIRED_MESSAGE_HEADERS, (row) => {
    const nativeId = row.id?.trim();
    if (!nativeId) throw new WorkstationError("MESSAGE_INVALID", `${path} 中存在缺少 id 的消息。`);
    // messages.csv is scoped by its containing chat directory.  Current
    // WhatsApp models can expose the local account as `chatId` for outgoing
    // messages, so chat.json is the authoritative relationship here.
    const chatNativeId = fallbackChatId;
    sortIndex += 1;
    const senderId = nullable(row.senderId);
    transaction.insertMessage({
      sourceId,
      nativeId,
      chatNativeId,
      sortIndex,
      senderId,
      senderDisplayName: senderId === null ? null : contacts.get(senderId) ?? null,
      recipientId: nullable(row.recipientId),
      fromMe: parseBoolean(row.fromMe),
      timestampUtc: normalizeTimestamp(row.timestamp),
      type: row.type?.trim() || "unknown",
      text: nullable(row.text),
      caption: nullable(row.caption),
      quotedMessageId: nullable(row.quotedMessageId),
      isForwarded: parseBoolean(row.isForwarded),
      isStarred: parseBoolean(row.isStarred),
      isRevoked: parseBoolean(row.isRevoked),
      acknowledgement: nullable(row.acknowledgement),
    });

    const media = mediaByMessage.get(nativeId) ?? [];
    if (media.length === 0 && parseBoolean(row.hasMedia)) {
      transaction.insertAttachment({
        opaqueId: randomUUID(),
        sourceId,
        messageNativeId: nativeId,
        relativePath: null,
        kind: attachmentKind(nullable(row.mediaMimeType), row.type),
        status: "missing",
        mimeType: nullable(row.mediaMimeType),
        fileName: nullable(row.mediaFileName),
        sizeBytes: parseNullableInteger(row.mediaSize),
        failureReason: "media_index_entry_missing",
      });
      return;
    }
    for (const record of media) {
      const resolved = resolveMediaRecord(sessionRoot, record);
      transaction.insertAttachment({
        opaqueId: randomUUID(),
        sourceId,
        messageNativeId: nativeId,
        relativePath: resolved.relativePath,
        kind: attachmentKind(record.mimeType, record.type ?? row.type),
        status: resolved.status,
        mimeType: record.mimeType ?? nullable(row.mediaMimeType),
        fileName: record.originalFileName ?? nullable(row.mediaFileName),
        sizeBytes: record.byteLength ?? parseNullableInteger(row.mediaSize),
        failureReason: record.failureReason,
      });
    }
  });
}

function readMediaIndex(path: string): Map<string, MediaIndexRecord[]> {
  const records = new Map<string, MediaIndexRecord[]>();
  for (const value of readJsonArray(path)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as JsonObject;
    const messageId = typeof item.messageId === "string" ? item.messageId : "";
    if (messageId === "") continue;
    const record: MediaIndexRecord = {
      messageId,
      relativePath: typeof item.relativePath === "string" ? item.relativePath : null,
      mimeType: typeof item.mimeType === "string" ? item.mimeType : null,
      originalFileName:
        typeof item.originalFileName === "string" ? item.originalFileName : null,
      byteLength:
        typeof item.byteLength === "number" && Number.isSafeInteger(item.byteLength)
          ? item.byteLength
          : null,
      type: typeof item.type === "string" ? item.type : null,
      status: typeof item.status === "string" ? item.status : "unavailable",
      failureReason: typeof item.failureReason === "string" ? item.failureReason : null,
    };
    const list = records.get(messageId) ?? [];
    list.push(record);
    records.set(messageId, list);
  }
  return records;
}

function resolveMediaRecord(
  sessionRoot: string,
  record: MediaIndexRecord,
): { relativePath: string | null; status: "available" | "missing" | "failed" } {
  if (record.relativePath === null) {
    return {
      relativePath: null,
      status: record.status === "available" ? "missing" : "failed",
    };
  }
  const relativePath = record.relativePath.replaceAll("/", sep);
  const target = resolve(sessionRoot, relativePath);
  if (!isPathInside(sessionRoot, target)) {
    throw new WorkstationError("MEDIA_PATH_ESCAPE", "媒体索引包含越界路径。");
  }
  if (!existsSync(target)) {
    return { relativePath: toPortableRelativePath(relative(sessionRoot, target)), status: "missing" };
  }
  assertSafeRegularFile(target, "媒体文件");
  return {
    relativePath: toPortableRelativePath(relative(sessionRoot, target)),
    status: record.status === "available" ? "available" : "failed",
  };
}

async function parseCsv(
  path: string,
  requiredHeaders: readonly string[],
  onRecord: (row: CsvRow) => void,
): Promise<void> {
  assertSafeRegularFile(path, basename(path));
  let headersSeen = false;
  const input = createReadStream(path);
  const parser = input.pipe(
    parse({
      bom: true,
      columns(headers: string[]) {
        headersSeen = true;
        const missing = requiredHeaders.filter((header) => !headers.includes(header));
        if (missing.length > 0) {
          throw new WorkstationError(
            "CSV_HEADERS_INVALID",
            `${basename(path)} 缺少列：${missing.join("、")}`,
          );
        }
        return headers;
      },
      max_record_size: 16 * 1024 * 1024,
      relax_column_count: false,
      skip_empty_lines: true,
    }),
  );
  input.on("error", (error) => parser.destroy(error));
  try {
    for await (const row of parser) onRecord(row as CsvRow);
  } catch (error) {
    if (error instanceof WorkstationError) throw error;
    throw new WorkstationError("CSV_INVALID", `${basename(path)} 不是有效 CSV。`, error);
  } finally {
    parser.destroy();
    input.destroy();
    await Promise.allSettled([finished(parser), finished(input)]);
  }
  if (!headersSeen) {
    throw new WorkstationError("CSV_HEADERS_INVALID", `${basename(path)} 缺少表头。`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseBoolean(value: string | undefined): boolean {
  return value === "true" || value === "1" || value === "TRUE";
}

function nullable(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function parseNullableInteger(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeTimestamp(value: string | undefined): string | null {
  const text = value?.trim() ?? "";
  if (text === "") return null;
  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  const date = new Date(text);
  return Number.isNaN(date.valueOf()) ? text : date.toISOString();
}

function attachmentKind(
  mimeType: string | null,
  messageType: string | undefined,
): "image" | "audio" | "video" | "document" | "other" {
  if (mimeType?.startsWith("image/")) return "image";
  if (mimeType?.startsWith("audio/")) return "audio";
  if (mimeType?.startsWith("video/")) return "video";
  if (messageType === "image" || messageType === "sticker") return "image";
  if (messageType === "audio" || messageType === "ptt") return "audio";
  if (messageType === "video") return "video";
  if (messageType === "document") return "document";
  if (mimeType !== null && mimeType !== "application/octet-stream") return "document";
  return "other";
}

function firstText(...values: unknown[]): string {
  return firstTextOrNull(...values) ?? "未命名会话";
}

function firstTextOrNull(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}
