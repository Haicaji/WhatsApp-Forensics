import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  CaseSummary,
  Chat,
  ChatQuery,
  CursorPage,
  IntegritySummary,
  Message,
  MessageQuery,
  SearchHit,
  SearchQuery,
  SourceSummary,
} from "@wafc/domain";

import type { EvidenceRepository } from "./index";

const CASE_DATABASE_SCHEMA_VERSION = 1;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 100;

type SqlRow = Record<string, unknown>;

export type CaseMetaInput = {
  caseId: string;
  name: string;
  authorizationReference: string;
  organization: string;
  description: string;
  status: "open" | "archived";
  createdAtUtc: string;
  updatedAtUtc: string;
};

export type SourceImportInput = {
  sourceId: string;
  evidenceId: string;
  assignmentId: string;
  operatorId: string;
  signerFingerprint: string;
  manifestRootSha256: string;
  bagPath: string;
  importedAtUtc: string;
  observationStartedAtUtc: string;
  observationEndedAtUtc: string;
  localSnapshot: "verified" | "partial" | "failed";
  historyScope: string;
  mediaScope: string;
  unresolvedReferences: number;
};

export type EntityImportInput = {
  recordId: string;
  sourceId: string;
  recordType: string;
  displayName: string | null;
  nativeIdentity: string | null;
  contentSha256: string;
  json: string;
};

export type ChatImportInput = {
  recordId: string;
  sourceId: string;
  title: string;
  kind: string;
  unreadCount: number;
  firstObservedAtUtc: string | null;
  lastObservedAtUtc: string | null;
  contentSha256: string;
  json: string;
};

export type MessageImportInput = {
  recordId: string;
  sourceId: string;
  chatRecordId: string;
  senderRecordId: string | null;
  senderDisplayName: string | null;
  chatTitle: string;
  sentAtUtc: string | null;
  kind: string;
  text: string | null;
  caption: string | null;
  fromMe: boolean;
  edited: boolean;
  revoked: boolean;
  starred: boolean;
  forwarded: boolean;
  attachmentCount: number;
  contentSha256: string;
  json: string;
};

export type AttachmentImportInput = {
  assetId: string;
  sourceId: string;
  mediaRole: string;
  mimeType: string | null;
  byteLength: number | null;
  sha256: string | null;
  casPath: string | null;
  sourceRecordIdsJson: string;
  json: string;
};

export type IntegrityDocumentInput = {
  sourceId: string;
  completenessJson: string;
  inventoryJson: string;
  verifierJson: string;
};

export type ImportCounts = {
  accountCount: number;
  contactCount: number;
  chatCount: number;
  messageCount: number;
  attachmentCount: number;
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === 1n;
}

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value)) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.max(value, 1), MAX_PAGE_SIZE);
}

function decodeOffset(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const value: unknown = JSON.parse(decoded);
    if (
      typeof value === "object" &&
      value !== null &&
      "offset" in value &&
      typeof value.offset === "number" &&
      Number.isSafeInteger(value.offset) &&
      value.offset >= 0
    ) {
      return value.offset;
    }
  } catch {
    // The public repository contract treats malformed cursors as invalid.
  }
  throw new Error("分页游标无效或已损坏");
}

function encodeOffset(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function mapMessage(row: SqlRow): Message {
  return {
    recordId: asString(row.record_id),
    sourceId: asString(row.source_id),
    chatRecordId: asString(row.chat_record_id),
    senderRecordId: nullableString(row.sender_record_id),
    senderDisplayName: nullableString(row.sender_display_name),
    sentAtUtc: nullableString(row.sent_at_utc),
    kind: asString(row.kind),
    text: nullableString(row.text),
    caption: nullableString(row.caption),
    flags: {
      fromMe: asBoolean(row.from_me),
      edited: asBoolean(row.edited),
      revoked: asBoolean(row.revoked),
      starred: asBoolean(row.starred),
      forwarded: asBoolean(row.forwarded),
    },
    attachmentCount: asNumber(row.attachment_count),
    contentSha256: asString(row.content_sha256),
  };
}

export function openCaseDatabase(databasePath: string): DatabaseSync {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath, { timeout: 5_000 });
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA trusted_schema = OFF;
    PRAGMA recursive_triggers = OFF;
    CREATE TABLE IF NOT EXISTS schema_meta (
      version INTEGER PRIMARY KEY,
      applied_at_utc TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS case_meta (
      case_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      authorization_reference TEXT NOT NULL,
      organization TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'archived')),
      created_at_utc TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sources (
      source_id TEXT PRIMARY KEY,
      evidence_id TEXT NOT NULL UNIQUE,
      assignment_id TEXT NOT NULL,
      operator_id TEXT NOT NULL,
      signer_fingerprint TEXT NOT NULL,
      manifest_root_sha256 TEXT NOT NULL,
      bag_path TEXT NOT NULL,
      imported_at_utc TEXT NOT NULL,
      observation_started_at_utc TEXT NOT NULL,
      observation_ended_at_utc TEXT NOT NULL,
      local_snapshot TEXT NOT NULL,
      history_scope TEXT NOT NULL,
      media_scope TEXT NOT NULL,
      unresolved_references INTEGER NOT NULL DEFAULT 0 CHECK (unresolved_references >= 0),
      account_count INTEGER NOT NULL DEFAULT 0 CHECK (account_count >= 0),
      contact_count INTEGER NOT NULL DEFAULT 0 CHECK (contact_count >= 0),
      chat_count INTEGER NOT NULL DEFAULT 0 CHECK (chat_count >= 0),
      message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
      attachment_count INTEGER NOT NULL DEFAULT 0 CHECK (attachment_count >= 0),
      UNIQUE (manifest_root_sha256, signer_fingerprint)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS entities (
      record_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(source_id),
      record_type TEXT NOT NULL,
      display_name TEXT,
      native_identity TEXT,
      content_sha256 TEXT NOT NULL,
      json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS entities_source_type_idx
      ON entities(source_id, record_type);
    CREATE TABLE IF NOT EXISTS chats (
      record_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(source_id),
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      unread_count INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
      message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
      first_observed_at_utc TEXT,
      last_observed_at_utc TEXT,
      last_message_preview TEXT,
      content_sha256 TEXT NOT NULL,
      json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS chats_source_last_idx
      ON chats(source_id, last_observed_at_utc DESC, record_id);
    CREATE TABLE IF NOT EXISTS messages (
      record_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(source_id),
      chat_record_id TEXT NOT NULL REFERENCES chats(record_id),
      sender_record_id TEXT,
      sender_display_name TEXT,
      chat_title TEXT NOT NULL,
      sent_at_utc TEXT,
      kind TEXT NOT NULL,
      text TEXT,
      caption TEXT,
      from_me INTEGER NOT NULL CHECK (from_me IN (0, 1)),
      edited INTEGER NOT NULL CHECK (edited IN (0, 1)),
      revoked INTEGER NOT NULL CHECK (revoked IN (0, 1)),
      starred INTEGER NOT NULL CHECK (starred IN (0, 1)),
      forwarded INTEGER NOT NULL CHECK (forwarded IN (0, 1)),
      attachment_count INTEGER NOT NULL DEFAULT 0 CHECK (attachment_count >= 0),
      content_sha256 TEXT NOT NULL,
      json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS messages_chat_time_idx
      ON messages(chat_record_id, sent_at_utc, record_id);
    CREATE INDEX IF NOT EXISTS messages_source_idx ON messages(source_id);
    CREATE TABLE IF NOT EXISTS attachments (
      asset_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(source_id),
      media_role TEXT NOT NULL,
      mime_type TEXT,
      byte_length INTEGER CHECK (byte_length IS NULL OR byte_length >= 0),
      sha256 TEXT,
      cas_path TEXT,
      source_record_ids_json TEXT NOT NULL,
      json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS attachments_source_idx ON attachments(source_id);
    CREATE TABLE IF NOT EXISTS integrity_documents (
      source_id TEXT PRIMARY KEY REFERENCES sources(source_id),
      completeness_json TEXT NOT NULL,
      inventory_json TEXT NOT NULL,
      verifier_json TEXT NOT NULL
    ) STRICT;
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text,
      caption,
      chat_title,
      sender_display_name,
      content='messages',
      content_rowid='rowid',
      tokenize='trigram'
    );
  `);
  database
    .prepare(
      "INSERT OR IGNORE INTO schema_meta(version, applied_at_utc) VALUES (?, ?)",
    )
    .run(CASE_DATABASE_SCHEMA_VERSION, new Date().toISOString());
  return database;
}

export class CaseImportWriter {
  readonly #database: DatabaseSync;
  #active = false;

  constructor(databasePath: string) {
    this.#database = openCaseDatabase(databasePath);
  }

  setCaseMeta(meta: CaseMetaInput): void {
    this.#database
      .prepare(`
        INSERT INTO case_meta(
          case_id, name, authorization_reference, organization, description,
          status, created_at_utc, updated_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(case_id) DO UPDATE SET
          name = excluded.name,
          authorization_reference = excluded.authorization_reference,
          organization = excluded.organization,
          description = excluded.description,
          status = excluded.status,
          updated_at_utc = excluded.updated_at_utc
      `)
      .run(
        meta.caseId,
        meta.name,
        meta.authorizationReference,
        meta.organization,
        meta.description,
        meta.status,
        meta.createdAtUtc,
        meta.updatedAtUtc,
      );
  }

  findEvidence(evidenceId: string): {
    manifestRootSha256: string;
    sourceId: string;
    chatCount: number;
    messageCount: number;
  } | null {
    const row = this.#database
      .prepare(`
        SELECT manifest_root_sha256, source_id, chat_count, message_count
        FROM sources WHERE evidence_id = ?
      `)
      .get(evidenceId) as SqlRow | undefined;
    return row
      ? {
          manifestRootSha256: asString(row.manifest_root_sha256),
          sourceId: asString(row.source_id),
          chatCount: asNumber(row.chat_count),
          messageCount: asNumber(row.message_count),
        }
      : null;
  }

  begin(): void {
    if (this.#active) throw new Error("导入事务已经开始");
    this.#database.exec("BEGIN IMMEDIATE");
    this.#active = true;
  }

  insertSource(source: SourceImportInput): void {
    this.#assertActive();
    this.#database
      .prepare(`
        INSERT INTO sources(
          source_id, evidence_id, assignment_id, operator_id,
          signer_fingerprint, manifest_root_sha256, bag_path, imported_at_utc,
          observation_started_at_utc, observation_ended_at_utc,
          local_snapshot, history_scope, media_scope, unresolved_references
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        source.sourceId,
        source.evidenceId,
        source.assignmentId,
        source.operatorId,
        source.signerFingerprint,
        source.manifestRootSha256,
        source.bagPath,
        source.importedAtUtc,
        source.observationStartedAtUtc,
        source.observationEndedAtUtc,
        source.localSnapshot,
        source.historyScope,
        source.mediaScope,
        source.unresolvedReferences,
      );
  }

  insertEntity(entity: EntityImportInput): void {
    this.#assertActive();
    this.#database
      .prepare(`
        INSERT INTO entities(
          record_id, source_id, record_type, display_name, native_identity,
          content_sha256, json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        entity.recordId,
        entity.sourceId,
        entity.recordType,
        entity.displayName,
        entity.nativeIdentity,
        entity.contentSha256,
        entity.json,
      );
  }

  insertChat(chat: ChatImportInput): void {
    this.#assertActive();
    this.#database
      .prepare(`
        INSERT INTO chats(
          record_id, source_id, title, kind, unread_count,
          first_observed_at_utc, last_observed_at_utc, content_sha256, json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        chat.recordId,
        chat.sourceId,
        chat.title,
        chat.kind,
        chat.unreadCount,
        chat.firstObservedAtUtc,
        chat.lastObservedAtUtc,
        chat.contentSha256,
        chat.json,
      );
  }

  insertMessage(message: MessageImportInput): void {
    this.#assertActive();
    this.#database
      .prepare(`
        INSERT INTO messages(
          record_id, source_id, chat_record_id, sender_record_id,
          sender_display_name, chat_title, sent_at_utc, kind, text, caption,
          from_me, edited, revoked, starred, forwarded, attachment_count,
          content_sha256, json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        message.recordId,
        message.sourceId,
        message.chatRecordId,
        message.senderRecordId,
        message.senderDisplayName,
        message.chatTitle,
        message.sentAtUtc,
        message.kind,
        message.text,
        message.caption,
        message.fromMe ? 1 : 0,
        message.edited ? 1 : 0,
        message.revoked ? 1 : 0,
        message.starred ? 1 : 0,
        message.forwarded ? 1 : 0,
        message.attachmentCount,
        message.contentSha256,
        message.json,
      );
    this.#database
      .prepare(`
        INSERT INTO messages_fts(rowid, text, caption, chat_title, sender_display_name)
        SELECT rowid, coalesce(text, ''), coalesce(caption, ''), chat_title,
          coalesce(sender_display_name, '')
        FROM messages WHERE record_id = ?
      `)
      .run(message.recordId);
  }

  insertAttachment(attachment: AttachmentImportInput): void {
    this.#assertActive();
    this.#database
      .prepare(`
        INSERT INTO attachments(
          asset_id, source_id, media_role, mime_type, byte_length, sha256,
          cas_path, source_record_ids_json, json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        attachment.assetId,
        attachment.sourceId,
        attachment.mediaRole,
        attachment.mimeType,
        attachment.byteLength,
        attachment.sha256,
        attachment.casPath,
        attachment.sourceRecordIdsJson,
        attachment.json,
      );
  }

  insertIntegrityDocuments(documents: IntegrityDocumentInput): void {
    this.#assertActive();
    this.#database
      .prepare(`
        INSERT INTO integrity_documents(
          source_id, completeness_json, inventory_json, verifier_json
        ) VALUES (?, ?, ?, ?)
      `)
      .run(
        documents.sourceId,
        documents.completenessJson,
        documents.inventoryJson,
        documents.verifierJson,
      );
  }

  finalizeSource(sourceId: string, counts: ImportCounts): void {
    this.#assertActive();
    this.#database
      .prepare(`
        UPDATE sources SET
          account_count = ?, contact_count = ?, chat_count = ?,
          message_count = ?, attachment_count = ?
        WHERE source_id = ?
      `)
      .run(
        counts.accountCount,
        counts.contactCount,
        counts.chatCount,
        counts.messageCount,
        counts.attachmentCount,
        sourceId,
      );
    this.#database
      .prepare(`
        UPDATE chats SET
          message_count = (
            SELECT count(*) FROM messages WHERE chat_record_id = chats.record_id
          ),
          last_message_preview = (
            SELECT coalesce(text, caption, '[' || kind || ']')
            FROM messages
            WHERE chat_record_id = chats.record_id
            ORDER BY sent_at_utc DESC, record_id DESC
            LIMIT 1
          )
        WHERE source_id = ?
      `)
      .run(sourceId);
  }

  commit(): void {
    this.#assertActive();
    this.#database.exec("COMMIT");
    this.#active = false;
  }

  rollback(): void {
    if (!this.#active) return;
    this.#database.exec("ROLLBACK");
    this.#active = false;
  }

  close(): void {
    this.rollback();
    this.#database.close();
  }

  #assertActive(): void {
    if (!this.#active) throw new Error("导入写入必须位于事务中");
  }
}

export class SqliteEvidenceRepository implements EvidenceRepository {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    this.#database = openCaseDatabase(databasePath);
  }

  async getCaseSummary(): Promise<CaseSummary> {
    const row = this.#database
      .prepare(`
        SELECT
          c.*,
          (SELECT count(*) FROM sources) AS source_count,
          (SELECT count(*) FROM chats) AS chat_count,
          (SELECT count(*) FROM messages) AS message_count,
          CASE
            WHEN (SELECT count(*) FROM sources) = 0 THEN 'empty'
            WHEN EXISTS(SELECT 1 FROM sources WHERE local_snapshot = 'failed') THEN 'failed'
            WHEN EXISTS(SELECT 1 FROM sources WHERE local_snapshot != 'verified'
              OR history_scope NOT IN ('terminal_observed', 'not_run')
              OR media_scope = 'partial') THEN 'partial'
            ELSE 'verified'
          END AS integrity
        FROM case_meta c LIMIT 1
      `)
      .get() as SqlRow | undefined;
    if (!row) throw new Error("案件数据库缺少案件元数据");
    return {
      caseId: asString(row.case_id),
      name: asString(row.name),
      authorizationReference: asString(row.authorization_reference),
      organization: asString(row.organization),
      description: asString(row.description),
      status: row.status === "archived" ? "archived" : "open",
      createdAtUtc: asString(row.created_at_utc),
      updatedAtUtc: asString(row.updated_at_utc),
      sourceCount: asNumber(row.source_count),
      chatCount: asNumber(row.chat_count),
      messageCount: asNumber(row.message_count),
      integrity:
        row.integrity === "verified" ||
        row.integrity === "partial" ||
        row.integrity === "failed"
          ? row.integrity
          : "empty",
    };
  }

  async listSources(): Promise<SourceSummary[]> {
    const rows = this.#database
      .prepare(`
        SELECT source_id, evidence_id, assignment_id, operator_id,
          signer_fingerprint, manifest_root_sha256, bag_path, imported_at_utc,
          observation_started_at_utc, observation_ended_at_utc,
          local_snapshot, history_scope, media_scope, message_count
        FROM sources ORDER BY imported_at_utc DESC, source_id
      `)
      .all() as SqlRow[];
    return rows.map((row) => ({
      sourceId: asString(row.source_id),
      evidenceId: asString(row.evidence_id),
      assignmentId: asString(row.assignment_id),
      operatorId: asString(row.operator_id),
      signerFingerprint: asString(row.signer_fingerprint),
      manifestRootSha256: asString(row.manifest_root_sha256),
      bagPath: asString(row.bag_path),
      importedAtUtc: asString(row.imported_at_utc),
      observationStartedAtUtc: asString(row.observation_started_at_utc),
      observationEndedAtUtc: asString(row.observation_ended_at_utc),
      localSnapshot:
        row.local_snapshot === "verified" || row.local_snapshot === "failed"
          ? row.local_snapshot
          : "partial",
      historyScope: asString(row.history_scope),
      mediaScope: asString(row.media_scope),
      messageCount: asNumber(row.message_count),
    }));
  }

  async listChats(query: ChatQuery = {}): Promise<CursorPage<Chat>> {
    const limit = clampLimit(query.limit);
    const offset = decodeOffset(query.cursor);
    const search = query.search?.trim() ?? "";
    const rows = this.#database
      .prepare(`
        SELECT record_id, source_id, title, kind, unread_count, message_count,
          first_observed_at_utc, last_observed_at_utc, last_message_preview
        FROM chats
        WHERE (? = '' OR instr(lower(title), lower(?)) > 0)
        ORDER BY coalesce(last_observed_at_utc, '') DESC, record_id
        LIMIT ? OFFSET ?
      `)
      .all(search, search, limit + 1, offset) as SqlRow[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map((row) => ({
      recordId: asString(row.record_id),
      sourceId: asString(row.source_id),
      title: asString(row.title),
      kind: asString(row.kind),
      unreadCount: asNumber(row.unread_count),
      messageCount: asNumber(row.message_count),
      firstObservedAtUtc: nullableString(row.first_observed_at_utc),
      lastObservedAtUtc: nullableString(row.last_observed_at_utc),
      lastMessagePreview: nullableString(row.last_message_preview),
    }));
    return {
      items: page,
      nextCursor: hasMore ? encodeOffset(offset + limit) : null,
    };
  }

  async listMessages(query: MessageQuery): Promise<CursorPage<Message>> {
    const limit = clampLimit(query.limit);
    const offset = decodeOffset(query.cursor);
    const descending = query.direction === "backward";
    const order = descending ? "DESC" : "ASC";
    const statement = this.#database.prepare(`
      SELECT * FROM messages
      WHERE chat_record_id = ?
      ORDER BY coalesce(sent_at_utc, '') ${order}, record_id ${order}
      LIMIT ? OFFSET ?
    `);
    const rows = statement.all(
      query.chatRecordId,
      limit + 1,
      offset,
    ) as SqlRow[];
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    if (descending) pageRows.reverse();
    return {
      items: pageRows.map(mapMessage),
      nextCursor: hasMore ? encodeOffset(offset + limit) : null,
    };
  }

  async searchMessages(query: SearchQuery): Promise<CursorPage<SearchHit>> {
    const text = query.text.trim();
    if (!text) return { items: [], nextCursor: null };
    const limit = clampLimit(query.limit);
    const offset = decodeOffset(query.cursor);
    const chat = query.chatRecordId ?? "";
    const source = query.sourceId ?? "";
    let rows: SqlRow[];
    if ([...text].length < 3) {
      rows = this.#database
        .prepare(`
          SELECT m.*, c.title AS chat_title,
            coalesce(m.text, m.caption, '[' || m.kind || ']') AS snippet,
            0.0 AS rank
          FROM messages m JOIN chats c ON c.record_id = m.chat_record_id
          WHERE (? = '' OR m.chat_record_id = ?)
            AND (? = '' OR m.source_id = ?)
            AND (
              instr(coalesce(m.text, ''), ?) > 0
              OR instr(coalesce(m.caption, ''), ?) > 0
              OR instr(c.title, ?) > 0
              OR instr(coalesce(m.sender_display_name, ''), ?) > 0
            )
          ORDER BY coalesce(m.sent_at_utc, '') DESC, m.record_id
          LIMIT ? OFFSET ?
        `)
        .all(
          chat,
          chat,
          source,
          source,
          text,
          text,
          text,
          text,
          limit + 1,
          offset,
        ) as SqlRow[];
    } else {
      const phrase = `"${text.replaceAll('"', '""')}"`;
      rows = this.#database
        .prepare(`
          SELECT m.*, c.title AS chat_title,
            snippet(messages_fts, 0, '〔', '〕', '…', 18) AS snippet,
            bm25(messages_fts) AS rank
          FROM messages_fts
          JOIN messages m ON m.rowid = messages_fts.rowid
          JOIN chats c ON c.record_id = m.chat_record_id
          WHERE messages_fts MATCH ?
            AND (? = '' OR m.chat_record_id = ?)
            AND (? = '' OR m.source_id = ?)
          ORDER BY rank, coalesce(m.sent_at_utc, '') DESC, m.record_id
          LIMIT ? OFFSET ?
        `)
        .all(phrase, chat, chat, source, source, limit + 1, offset) as SqlRow[];
    }
    const hasMore = rows.length > limit;
    return {
      items: rows.slice(0, limit).map((row) => ({
        message: mapMessage(row),
        chatTitle: asString(row.chat_title),
        snippet: asString(row.snippet),
        rank: asNumber(row.rank),
      })),
      nextCursor: hasMore ? encodeOffset(offset + limit) : null,
    };
  }

  async getMessageContext(recordId: string, radius: number): Promise<Message[]> {
    const boundedRadius = Math.min(Math.max(Math.trunc(radius), 0), 50);
    const target = this.#database
      .prepare(
        "SELECT chat_record_id, sent_at_utc, record_id FROM messages WHERE record_id = ?",
      )
      .get(recordId) as SqlRow | undefined;
    if (!target) return [];
    const chatRecordId = asString(target.chat_record_id);
    const sentAtUtc = nullableString(target.sent_at_utc);
    const targetRecordId = asString(target.record_id);
    const rows = this.#database
      .prepare(`
        SELECT * FROM (
          SELECT * FROM messages
          WHERE chat_record_id = ? AND (
            coalesce(sent_at_utc, '') < coalesce(?, '')
            OR (coalesce(sent_at_utc, '') = coalesce(?, '') AND record_id <= ?)
          )
          ORDER BY coalesce(sent_at_utc, '') DESC, record_id DESC
          LIMIT ?
        )
        UNION ALL
        SELECT * FROM (
          SELECT * FROM messages
          WHERE chat_record_id = ? AND (
            coalesce(sent_at_utc, '') > coalesce(?, '')
            OR (coalesce(sent_at_utc, '') = coalesce(?, '') AND record_id > ?)
          )
          ORDER BY coalesce(sent_at_utc, ''), record_id
          LIMIT ?
        )
        ORDER BY coalesce(sent_at_utc, ''), record_id
      `)
      .all(
        chatRecordId,
        sentAtUtc,
        sentAtUtc,
        targetRecordId,
        boundedRadius + 1,
        chatRecordId,
        sentAtUtc,
        sentAtUtc,
        targetRecordId,
        boundedRadius,
      ) as SqlRow[];
    return rows.map(mapMessage);
  }

  async getIntegrity(): Promise<IntegritySummary> {
    const sources = await this.listSources();
    const row = this.#database
      .prepare(`
        SELECT
          coalesce(sum(message_count), 0) AS total_messages,
          coalesce(sum(unresolved_references), 0) AS unresolved_references,
          sum(CASE WHEN local_snapshot != 'failed' THEN 1 ELSE 0 END) AS trusted_sources
        FROM sources
      `)
      .get() as SqlRow;
    let overall: IntegritySummary["overall"] = "empty";
    if (sources.length > 0) {
      if (sources.some((source) => source.localSnapshot === "failed")) {
        overall = "failed";
      } else if (
        sources.some(
          (source) =>
            source.localSnapshot !== "verified" ||
            !["terminal_observed", "not_run"].includes(source.historyScope) ||
            source.mediaScope === "partial",
        )
      ) {
        overall = "partial";
      } else {
        overall = "verified";
      }
    }
    const limitations = [
      "完整性仅覆盖采集时段内 WhatsApp Web 客户端可观察数据，不证明账号服务端绝对全量。",
    ];
    if (sources.some((source) => source.historyScope === "not_run")) {
      limitations.push("部分来源仅执行被动 T0，未主动加载历史记录。" );
    }
    if (sources.some((source) => source.mediaScope !== "complete")) {
      limitations.push("部分来源未请求或未完整获取媒体内容。" );
    }
    return {
      overall,
      sourceCount: sources.length,
      trustedSourceCount: asNumber(row.trusted_sources),
      totalMessages: asNumber(row.total_messages),
      unresolvedReferences: asNumber(row.unresolved_references),
      sources,
      limitations,
    };
  }

  async close(): Promise<void> {
    this.#database.close();
  }
}
