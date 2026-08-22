import { DatabaseSync, type StatementSync } from "node:sqlite";

import type {
  AttachmentView,
  ChatQuery,
  ChatSummary,
  CursorPage,
  EvidenceSource,
  MessageQuery,
  MessageView,
  TaskSummary,
} from "@wafc/domain";

import type {
  AssetLocation,
  CaseManifest,
  ChatPhoneIdentity,
  NewAttachmentRecord,
  NewChatRecord,
  NewMessageRecord,
  NewSourceRecord,
  RepositoryCounts,
} from "./index.js";

type SqlRow = Record<string, unknown>;

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;

CREATE TABLE IF NOT EXISTS case_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  task_name TEXT NOT NULL,
  usb_root TEXT NOT NULL,
  collector_directory TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  disabled_at_utc TEXT,
  received_count INTEGER NOT NULL DEFAULT 0 CHECK (received_count >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS sources (
  source_id TEXT PRIMARY KEY,
  specimen_name TEXT NOT NULL,
  schema_version TEXT NOT NULL CHECK (schema_version IN ('field-collector-session/5', 'field-collector-session/6')),
  collection_status TEXT NOT NULL CHECK (collection_status IN ('complete', 'cancelled', 'failed')),
  task_id TEXT,
  session_id TEXT NOT NULL,
  import_fingerprint TEXT NOT NULL UNIQUE,
  raw_relative_path TEXT NOT NULL,
  imported_at_utc TEXT NOT NULL,
  started_at_utc TEXT,
  finished_at_utc TEXT,
  warning TEXT,
  chat_count INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  media_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (task_id) REFERENCES tasks(task_id),
  UNIQUE (task_id, session_id)
) STRICT;

CREATE TABLE IF NOT EXISTS chats (
  source_id TEXT NOT NULL,
  native_id TEXT NOT NULL,
  title TEXT NOT NULL,
  phone_number TEXT,
  formatted_phone_number TEXT,
  kind TEXT NOT NULL,
  participant_count INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_at_utc TEXT,
  last_message_preview TEXT,
  PRIMARY KEY (source_id, native_id),
  FOREIGN KEY (source_id) REFERENCES sources(source_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS messages (
  source_id TEXT NOT NULL,
  native_id TEXT NOT NULL,
  chat_native_id TEXT NOT NULL,
  sort_index INTEGER NOT NULL,
  sender_id TEXT,
  sender_display_name TEXT,
  recipient_id TEXT,
  from_me INTEGER NOT NULL CHECK (from_me IN (0, 1)),
  timestamp_utc TEXT,
  type TEXT NOT NULL,
  text TEXT,
  caption TEXT,
  quoted_message_id TEXT,
  is_forwarded INTEGER NOT NULL CHECK (is_forwarded IN (0, 1)),
  is_starred INTEGER NOT NULL CHECK (is_starred IN (0, 1)),
  is_revoked INTEGER NOT NULL CHECK (is_revoked IN (0, 1)),
  acknowledgement TEXT,
  PRIMARY KEY (source_id, native_id),
  FOREIGN KEY (source_id, chat_native_id) REFERENCES chats(source_id, native_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS messages_chat_order_idx
  ON messages(source_id, chat_native_id, sort_index DESC);

CREATE TABLE IF NOT EXISTS attachments (
  opaque_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  message_native_id TEXT NOT NULL,
  relative_path TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'audio', 'video', 'document', 'other')),
  status TEXT NOT NULL CHECK (status IN ('available', 'missing', 'failed')),
  mime_type TEXT,
  file_name TEXT,
  size_bytes INTEGER,
  failure_reason TEXT,
  FOREIGN KEY (source_id, message_native_id) REFERENCES messages(source_id, native_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS attachments_message_idx
  ON attachments(source_id, message_native_id);
`;

function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : asString(value);
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function asBoolean(value: unknown): boolean {
  return asNumber(value) === 1;
}

function ensureColumn(
  database: DatabaseSync,
  table: "chats",
  column: "phone_number" | "formatted_phone_number",
): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[];
  if (columns.some((row) => asString(row.name) === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
}

function sourceFromRow(row: SqlRow): EvidenceSource {
  return {
    sourceId: asString(row.source_id),
    specimenName: asString(row.specimen_name),
    schemaVersion: asString(row.schema_version) as EvidenceSource["schemaVersion"],
    collectionStatus: asString(row.collection_status) as EvidenceSource["collectionStatus"],
    taskId: nullableString(row.task_id),
    sessionId: asString(row.session_id),
    importedAtUtc: asString(row.imported_at_utc),
    startedAtUtc: nullableString(row.started_at_utc),
    finishedAtUtc: nullableString(row.finished_at_utc),
    chatCount: asNumber(row.chat_count),
    messageCount: asNumber(row.message_count),
    mediaCount: asNumber(row.media_count),
    warning: nullableString(row.warning),
  };
}

function taskFromRow(row: SqlRow): TaskSummary {
  return {
    taskId: asString(row.task_id),
    caseId: asString(row.case_id),
    taskName: asString(row.task_name),
    usbRoot: asString(row.usb_root),
    collectorDirectory: asString(row.collector_directory),
    createdAtUtc: asString(row.created_at_utc),
    status: asString(row.status) as TaskSummary["status"],
    disabledAtUtc: nullableString(row.disabled_at_utc),
    receivedCount: asNumber(row.received_count),
  };
}

function attachmentFromRow(row: SqlRow): AttachmentView {
  const opaqueId = asString(row.opaque_id);
  const status = asString(row.status) as AttachmentView["status"];
  return {
    opaqueId,
    sourceId: asString(row.source_id),
    messageNativeId: asString(row.message_native_id),
    kind: asString(row.kind) as AttachmentView["kind"],
    status,
    mimeType: nullableString(row.mime_type),
    fileName: nullableString(row.file_name),
    sizeBytes: row.size_bytes === null ? null : asNumber(row.size_bytes),
    url: status === "available" ? `wafc-media://asset/${opaqueId}` : null,
    failureReason: nullableString(row.failure_reason),
  };
}

export class SessionImportTransaction {
  readonly #database: DatabaseSync;
  readonly #sourceId: string;
  readonly #taskId: string | null;
  readonly #insertChat: StatementSync;
  readonly #insertMessage: StatementSync;
  readonly #insertAttachment: StatementSync;
  #closed = false;
  #chatCount = 0;
  #messageCount = 0;
  #mediaCount = 0;

  constructor(database: DatabaseSync, source: NewSourceRecord) {
    this.#database = database;
    this.#sourceId = source.sourceId;
    this.#taskId = source.taskId;
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(`
          INSERT INTO sources (
            source_id, specimen_name, schema_version, collection_status, task_id,
            session_id, import_fingerprint, raw_relative_path, imported_at_utc,
            started_at_utc, finished_at_utc, warning
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          source.sourceId,
          source.specimenName,
          source.schemaVersion,
          source.collectionStatus,
          source.taskId,
          source.sessionId,
          source.importFingerprint,
          source.rawRelativePath,
          source.importedAtUtc,
          source.startedAtUtc,
          source.finishedAtUtc,
          source.warning,
        );
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    this.#insertChat = database.prepare(`
      INSERT INTO chats (
        source_id, native_id, title, phone_number, formatted_phone_number, kind, participant_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.#insertMessage = database.prepare(`
      INSERT INTO messages (
        source_id, native_id, chat_native_id, sort_index, sender_id,
        sender_display_name, recipient_id, from_me, timestamp_utc, type,
        text, caption, quoted_message_id, is_forwarded, is_starred,
        is_revoked, acknowledgement
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#insertAttachment = database.prepare(`
      INSERT INTO attachments (
        opaque_id, source_id, message_native_id, relative_path, kind, status,
        mime_type, file_name, size_bytes, failure_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  insertChat(chat: NewChatRecord): void {
    this.#ensureOpen();
    this.#ensureSource(chat.sourceId);
    this.#insertChat.run(
      chat.sourceId,
      chat.nativeId,
      chat.title,
      chat.phoneNumber,
      chat.formattedPhoneNumber,
      chat.kind,
      chat.participantCount,
    );
    this.#chatCount += 1;
  }

  insertMessage(message: NewMessageRecord): void {
    this.#ensureOpen();
    this.#ensureSource(message.sourceId);
    this.#insertMessage.run(
      message.sourceId,
      message.nativeId,
      message.chatNativeId,
      message.sortIndex,
      message.senderId,
      message.senderDisplayName,
      message.recipientId,
      Number(message.fromMe),
      message.timestampUtc,
      message.type,
      message.text,
      message.caption,
      message.quotedMessageId,
      Number(message.isForwarded),
      Number(message.isStarred),
      Number(message.isRevoked),
      message.acknowledgement,
    );
    this.#messageCount += 1;
  }

  insertAttachment(attachment: NewAttachmentRecord): void {
    this.#ensureOpen();
    this.#ensureSource(attachment.sourceId);
    this.#insertAttachment.run(
      attachment.opaqueId,
      attachment.sourceId,
      attachment.messageNativeId,
      attachment.relativePath,
      attachment.kind,
      attachment.status,
      attachment.mimeType,
      attachment.fileName,
      attachment.sizeBytes,
      attachment.failureReason,
    );
    this.#mediaCount += 1;
  }

  commit(): void {
    this.#ensureOpen();
    this.#database
      .prepare(`
        UPDATE sources
        SET chat_count = ?, message_count = ?, media_count = ?
        WHERE source_id = ?
      `)
      .run(this.#chatCount, this.#messageCount, this.#mediaCount, this.#sourceId);
    this.#database.prepare(`
      UPDATE chats
      SET
        message_count = (
          SELECT COUNT(*) FROM messages
          WHERE messages.source_id = chats.source_id
            AND messages.chat_native_id = chats.native_id
        ),
        last_message_at_utc = (
          SELECT timestamp_utc FROM messages
          WHERE messages.source_id = chats.source_id
            AND messages.chat_native_id = chats.native_id
          ORDER BY sort_index DESC LIMIT 1
        ),
        last_message_preview = (
          SELECT COALESCE(NULLIF(text, ''), NULLIF(caption, ''), type) FROM messages
          WHERE messages.source_id = chats.source_id
            AND messages.chat_native_id = chats.native_id
          ORDER BY sort_index DESC LIMIT 1
        )
      WHERE source_id = ?
    `).run(this.#sourceId);
    if (this.#taskId !== null) {
      this.#database
        .prepare("UPDATE tasks SET received_count = received_count + 1 WHERE task_id = ?")
        .run(this.#taskId);
    }
    this.#database.exec("COMMIT");
    this.#closed = true;
  }

  rollback(): void {
    if (!this.#closed) {
      this.#database.exec("ROLLBACK");
      this.#closed = true;
    }
  }

  #ensureOpen(): void {
    if (this.#closed) throw new Error("import transaction is closed");
  }

  #ensureSource(sourceId: string): void {
    if (sourceId !== this.#sourceId) throw new Error("record belongs to another source");
  }
}

export class CaseRepository {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec(SCHEMA);
    ensureColumn(this.#database, "chats", "phone_number");
    ensureColumn(this.#database, "chats", "formatted_phone_number");
  }

  close(): void {
    this.#database.close();
  }

  initializeManifest(manifest: CaseManifest): void {
    const statement = this.#database.prepare(`
      INSERT INTO case_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      for (const [key, value] of Object.entries(manifest)) {
        statement.run(key, value);
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  getManifest(): CaseManifest {
    const rows = this.#database.prepare("SELECT key, value FROM case_meta").all() as SqlRow[];
    const values = Object.fromEntries(rows.map((row) => [asString(row.key), asString(row.value)]));
    return {
      schemaVersion: values.schemaVersion as "wafc-analysis-case/1",
      caseId: values.caseId ?? "",
      name: values.name ?? "",
      createdAtUtc: values.createdAtUtc ?? "",
    };
  }

  insertTask(task: TaskSummary): void {
    this.#database
      .prepare(`
        INSERT INTO tasks (
          task_id, case_id, task_name, usb_root, collector_directory,
          created_at_utc, status, disabled_at_utc, received_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        task.taskId,
        task.caseId,
        task.taskName,
        task.usbRoot,
        task.collectorDirectory,
        task.createdAtUtc,
        task.status,
        task.disabledAtUtc,
        task.receivedCount,
      );
  }

  listTasks(): TaskSummary[] {
    return (this.#database
      .prepare("SELECT * FROM tasks ORDER BY created_at_utc DESC")
      .all() as SqlRow[]).map(taskFromRow);
  }

  getTask(taskId: string): TaskSummary | null {
    const row = this.#database
      .prepare("SELECT * FROM tasks WHERE task_id = ?")
      .get(taskId) as SqlRow | undefined;
    return row ? taskFromRow(row) : null;
  }

  disableTask(taskId: string, disabledAtUtc: string): TaskSummary | null {
    this.#database
      .prepare(`
        UPDATE tasks SET status = 'disabled', disabled_at_utc = ?
        WHERE task_id = ? AND status = 'active'
      `)
      .run(disabledAtUtc, taskId);
    return this.getTask(taskId);
  }

  incrementTaskReceived(taskId: string): void {
    this.#database
      .prepare("UPDATE tasks SET received_count = received_count + 1 WHERE task_id = ?")
      .run(taskId);
  }

  findSourceByFingerprint(fingerprint: string): EvidenceSource | null {
    const row = this.#database
      .prepare("SELECT * FROM sources WHERE import_fingerprint = ?")
      .get(fingerprint) as SqlRow | undefined;
    return row ? sourceFromRow(row) : null;
  }

  findSourceByTaskSession(taskId: string, sessionId: string): EvidenceSource | null {
    const row = this.#database
      .prepare("SELECT * FROM sources WHERE task_id = ? AND session_id = ?")
      .get(taskId, sessionId) as SqlRow | undefined;
    return row ? sourceFromRow(row) : null;
  }

  beginSessionImport(source: NewSourceRecord): SessionImportTransaction {
    return new SessionImportTransaction(this.#database, source);
  }

  listSources(): EvidenceSource[] {
    return (this.#database
      .prepare("SELECT * FROM sources ORDER BY imported_at_utc DESC")
      .all() as SqlRow[]).map(sourceFromRow);
  }

  getSource(sourceId: string): EvidenceSource | null {
    const row = this.#database
      .prepare("SELECT * FROM sources WHERE source_id = ?")
      .get(sourceId) as SqlRow | undefined;
    return row ? sourceFromRow(row) : null;
  }

  getSourceRawRelativePath(sourceId: string): string | null {
    const row = this.#database
      .prepare("SELECT raw_relative_path FROM sources WHERE source_id = ?")
      .get(sourceId) as SqlRow | undefined;
    return row ? asString(row.raw_relative_path) : null;
  }

  backfillChatPhoneIdentities(
    sourceId: string,
    identities: readonly ChatPhoneIdentity[],
  ): void {
    if (identities.length === 0) return;
    const statement = this.#database.prepare(`
      UPDATE chats
      SET
        phone_number = COALESCE(phone_number, ?),
        formatted_phone_number = COALESCE(formatted_phone_number, ?)
      WHERE source_id = ? AND native_id = ?
    `);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      for (const identity of identities) {
        if (identity.phoneNumber === null && identity.formattedPhoneNumber === null) continue;
        statement.run(
          identity.phoneNumber,
          identity.formattedPhoneNumber,
          sourceId,
          identity.nativeId,
        );
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  listChats(query: ChatQuery): CursorPage<ChatSummary> {
    const offset = Math.max(0, Number.parseInt(query.cursor ?? "0", 10) || 0);
    const search = `%${query.search.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const rows = this.#database
      .prepare(`
        SELECT chats.*,
          (
            SELECT COUNT(*) FROM attachments
            JOIN messages
              ON messages.source_id = attachments.source_id
             AND messages.native_id = attachments.message_native_id
            WHERE messages.source_id = chats.source_id
              AND messages.chat_native_id = chats.native_id
          ) AS media_count,
          (
            SELECT COUNT(*) FROM messages
            WHERE messages.source_id = chats.source_id
              AND messages.chat_native_id = chats.native_id
              AND messages.is_starred = 1
          ) AS starred_message_count
        FROM chats
        WHERE source_id = ? AND title LIKE ? ESCAPE '\\'
        ORDER BY COALESCE(last_message_at_utc, '') DESC, title COLLATE NOCASE
        LIMIT ? OFFSET ?
      `)
      .all(query.sourceId, search, query.limit + 1, offset) as SqlRow[];
    const hasMore = rows.length > query.limit;
    const pageRows = rows.slice(0, query.limit);
    return {
      items: pageRows.map((row) => ({
        sourceId: asString(row.source_id),
        nativeId: asString(row.native_id),
        title: asString(row.title),
        phoneNumber: nullableString(row.phone_number),
        formattedPhoneNumber: nullableString(row.formatted_phone_number),
        avatarUrl: null,
        kind: asString(row.kind),
        participantCount: asNumber(row.participant_count),
        messageCount: asNumber(row.message_count),
        mediaCount: asNumber(row.media_count),
        starredMessageCount: asNumber(row.starred_message_count),
        lastMessageAtUtc: nullableString(row.last_message_at_utc),
        lastMessagePreview: nullableString(row.last_message_preview),
        community: null,
      })),
      nextCursor: hasMore ? String(offset + query.limit) : null,
    };
  }

  listMessages(query: MessageQuery): CursorPage<MessageView> {
    const cursor = query.beforeCursor === null ? Number.MAX_SAFE_INTEGER : Number(query.beforeCursor);
    const rows = this.#database
      .prepare(`
        SELECT * FROM messages
        WHERE source_id = ? AND chat_native_id = ? AND sort_index < ?
        ORDER BY sort_index DESC
        LIMIT ?
      `)
      .all(query.sourceId, query.chatNativeId, cursor, query.limit + 1) as SqlRow[];
    const hasMore = rows.length > query.limit;
    const pageRows = rows.slice(0, query.limit);
    const attachmentStatement = this.#database.prepare(`
      SELECT * FROM attachments
      WHERE source_id = ? AND message_native_id = ?
      ORDER BY opaque_id
    `);
    const messages = pageRows.map((row) => {
      const attachments = attachmentStatement
        .all(asString(row.source_id), asString(row.native_id)) as SqlRow[];
      return {
        sourceId: asString(row.source_id),
        nativeId: asString(row.native_id),
        chatNativeId: asString(row.chat_native_id),
        senderId: nullableString(row.sender_id),
        senderDisplayName: nullableString(row.sender_display_name),
        recipientId: nullableString(row.recipient_id),
        fromMe: asBoolean(row.from_me),
        timestampUtc: nullableString(row.timestamp_utc),
        type: asString(row.type),
        text: nullableString(row.text),
        caption: nullableString(row.caption),
        quotedMessageId: nullableString(row.quoted_message_id),
        isForwarded: asBoolean(row.is_forwarded),
        isStarred: asBoolean(row.is_starred),
        isRevoked: asBoolean(row.is_revoked),
        acknowledgement: nullableString(row.acknowledgement),
        attachments: attachments.map(attachmentFromRow),
        sortIndex: asNumber(row.sort_index),
      };
    });
    const nextCursor = hasMore
      ? String(messages.at(-1)?.sortIndex ?? "")
      : null;
    return {
      items: messages
        .map(({ sortIndex: _sortIndex, ...message }) => message)
        .reverse(),
      nextCursor,
    };
  }

  getAssetLocation(opaqueId: string): AssetLocation | null {
    const row = this.#database
      .prepare(`
        SELECT a.source_id, a.relative_path, a.status, a.mime_type, a.file_name,
               s.raw_relative_path
        FROM attachments a
        JOIN sources s ON s.source_id = a.source_id
        WHERE a.opaque_id = ?
      `)
      .get(opaqueId) as SqlRow | undefined;
    if (!row) return null;
    return {
      sourceId: asString(row.source_id),
      rawRelativePath: asString(row.raw_relative_path),
      attachmentRelativePath: nullableString(row.relative_path),
      status: asString(row.status) as AssetLocation["status"],
      mimeType: nullableString(row.mime_type),
      fileName: nullableString(row.file_name),
    };
  }

  getCounts(): RepositoryCounts {
    const row = this.#database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM sources) AS source_count,
        (SELECT COUNT(*) FROM tasks) AS task_count,
        (SELECT COUNT(*) FROM chats) AS chat_count,
        (SELECT COUNT(*) FROM messages) AS message_count
    `).get() as SqlRow;
    return {
      sourceCount: asNumber(row.source_count),
      taskCount: asNumber(row.task_count),
      chatCount: asNumber(row.chat_count),
      messageCount: asNumber(row.message_count),
    };
  }
}
