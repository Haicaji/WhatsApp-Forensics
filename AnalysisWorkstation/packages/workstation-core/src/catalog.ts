import { DatabaseSync } from "node:sqlite";

import type { CaseSummary } from "@wafc/domain";
import type { RepositoryCounts } from "@wafc/evidence-repository";

type SqlRow = Record<string, unknown>;

function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function rowToCase(row: SqlRow): CaseSummary {
  return {
    caseId: asString(row.case_id),
    name: asString(row.name),
    path: asString(row.path),
    createdAtUtc: asString(row.created_at_utc),
    updatedAtUtc: asString(row.updated_at_utc),
    lastOpenedAtUtc:
      row.last_opened_at_utc === null ? null : asString(row.last_opened_at_utc),
    sourceCount: asNumber(row.source_count),
    taskCount: asNumber(row.task_count),
    chatCount: asNumber(row.chat_count),
    messageCount: asNumber(row.message_count),
  };
}

export class CaseCatalog {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS cases (
        case_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at_utc TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL,
        last_opened_at_utc TEXT,
        source_count INTEGER NOT NULL DEFAULT 0,
        task_count INTEGER NOT NULL DEFAULT 0,
        chat_count INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE INDEX IF NOT EXISTS cases_opened_idx
        ON cases(COALESCE(last_opened_at_utc, created_at_utc) DESC);
    `);
  }

  close(): void {
    this.#database.close();
  }

  listCases(): CaseSummary[] {
    return (this.#database
      .prepare(`
        SELECT * FROM cases
        ORDER BY COALESCE(last_opened_at_utc, created_at_utc) DESC, name COLLATE NOCASE
      `)
      .all() as SqlRow[]).map(rowToCase);
  }

  getCase(caseId: string): CaseSummary | null {
    const row = this.#database
      .prepare("SELECT * FROM cases WHERE case_id = ?")
      .get(caseId) as SqlRow | undefined;
    return row ? rowToCase(row) : null;
  }

  insertCase(summary: CaseSummary): void {
    this.#database
      .prepare(`
        INSERT INTO cases (
          case_id, name, path, created_at_utc, updated_at_utc,
          last_opened_at_utc, source_count, task_count, chat_count, message_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        summary.caseId,
        summary.name,
        summary.path,
        summary.createdAtUtc,
        summary.updatedAtUtc,
        summary.lastOpenedAtUtc,
        summary.sourceCount,
        summary.taskCount,
        summary.chatCount,
        summary.messageCount,
      );
  }

  updatePath(caseId: string, path: string): void {
    this.#database
      .prepare("UPDATE cases SET path = ? WHERE case_id = ?")
      .run(path, caseId);
  }

  markOpened(caseId: string, openedAtUtc: string): void {
    this.#database
      .prepare(`
        UPDATE cases
        SET last_opened_at_utc = ?, updated_at_utc = ?
        WHERE case_id = ?
      `)
      .run(openedAtUtc, openedAtUtc, caseId);
  }

  updateCounts(caseId: string, counts: RepositoryCounts, updatedAtUtc: string): void {
    this.#database
      .prepare(`
        UPDATE cases SET
          source_count = ?, task_count = ?, chat_count = ?, message_count = ?,
          updated_at_utc = ?
        WHERE case_id = ?
      `)
      .run(
        counts.sourceCount,
        counts.taskCount,
        counts.chatCount,
        counts.messageCount,
        updatedAtUtc,
        caseId,
      );
  }
}
