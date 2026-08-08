import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  type CaseSummary,
  type CreateCaseInput,
  createCaseInputSchema,
} from "@wafc/domain";
import {
  CaseImportWriter,
  SqliteEvidenceRepository,
} from "@wafc/evidence-repository/node";

import { ensureRealDirectory, fixedCasePaths } from "./paths";

type SqlRow = Record<string, unknown>;

export type RegisteredAssignment = {
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

export type AssignmentRegistration = RegisteredAssignment & {
  operatorDisplayName: string;
  operatorOrganization: string;
  operatorPublicKeySpkiBase64: string;
  receiptJson: string;
  registeredAtUtc: string;
};

function value(row: SqlRow, key: string): string {
  const result = row[key];
  return typeof result === "string" ? result : "";
}

function numberValue(row: SqlRow, key: string): number {
  const result = row[key];
  return typeof result === "number" ? result : Number(result ?? 0);
}

export class WorkstationCatalog {
  readonly dataRoot: string;
  readonly provisioningStateDir: string;
  readonly #database: DatabaseSync;

  constructor(dataRoot: string) {
    this.dataRoot = ensureRealDirectory(dataRoot, "工作站数据目录");
    this.provisioningStateDir = join(this.dataRoot, "provisioning");
    mkdirSync(join(this.dataRoot, "cases"), { recursive: true });
    const databasePath = join(this.dataRoot, "workstation.sqlite");
    this.#database = new DatabaseSync(databasePath, { timeout: 5_000 });
    this.#database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS cases (
        case_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        authorization_reference TEXT NOT NULL,
        organization TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'archived')),
        created_at_utc TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL,
        source_count INTEGER NOT NULL DEFAULT 0 CHECK (source_count >= 0),
        chat_count INTEGER NOT NULL DEFAULT 0 CHECK (chat_count >= 0),
        message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
        integrity TEXT NOT NULL DEFAULT 'empty'
          CHECK (integrity IN ('empty', 'verified', 'partial', 'failed'))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS operators (
        operator_id TEXT NOT NULL,
        key_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        organization TEXT NOT NULL,
        public_key_spki_base64 TEXT NOT NULL,
        fingerprint_sha256 TEXT NOT NULL UNIQUE,
        registered_at_utc TEXT NOT NULL,
        PRIMARY KEY(operator_id, key_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS assignments (
        assignment_id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES cases(case_id),
        operator_id TEXT NOT NULL,
        operator_key_id TEXT NOT NULL,
        operator_fingerprint TEXT NOT NULL REFERENCES operators(fingerprint_sha256),
        bundle_id TEXT NOT NULL,
        authorization_reference TEXT NOT NULL,
        valid_from_utc TEXT NOT NULL,
        valid_until_utc TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        registered_at_utc TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS assignments_case_idx ON assignments(case_id);
      CREATE TABLE IF NOT EXISTS intake_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        at_utc TEXT NOT NULL,
        case_id TEXT NOT NULL,
        action TEXT NOT NULL,
        evidence_id TEXT,
        manifest_root_sha256 TEXT,
        result TEXT NOT NULL,
        detail_code TEXT NOT NULL
      ) STRICT;
    `);
  }

  createCase(input: CreateCaseInput, now = new Date()): CaseSummary {
    const parsed = createCaseInputSchema.parse(input);
    const createdAtUtc = now.toISOString();
    const paths = fixedCasePaths(this.dataRoot, parsed.caseId);
    if (this.getCase(parsed.caseId)) {
      throw new Error(`案件 ${parsed.caseId} 已存在`);
    }
    mkdirSync(paths.root, { recursive: false });
    for (const directory of [
      paths.sources,
      paths.derived,
      paths.reports,
      paths.audit,
    ]) {
      mkdirSync(directory, { recursive: false });
    }
    this.#database
      .prepare(`
        INSERT INTO cases(
          case_id, name, authorization_reference, organization, description,
          status, created_at_utc, updated_at_utc
        ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)
      `)
      .run(
        parsed.caseId,
        parsed.name,
        parsed.authorizationReference,
        parsed.organization,
        parsed.description,
        createdAtUtc,
        createdAtUtc,
      );
    const writer = new CaseImportWriter(paths.database);
    writer.setCaseMeta({
      caseId: parsed.caseId,
      name: parsed.name,
      authorizationReference: parsed.authorizationReference,
      organization: parsed.organization,
      description: parsed.description,
      status: "open",
      createdAtUtc,
      updatedAtUtc: createdAtUtc,
    });
    writer.close();
    const result = this.getCase(parsed.caseId);
    if (!result) throw new Error("案件创建后无法读取");
    return result;
  }

  listCases(): CaseSummary[] {
    const rows = this.#database
      .prepare("SELECT * FROM cases ORDER BY updated_at_utc DESC, case_id")
      .all() as SqlRow[];
    return rows.map((row) => this.#mapCase(row));
  }

  getCase(caseId: string): CaseSummary | null {
    const row = this.#database
      .prepare("SELECT * FROM cases WHERE case_id = ?")
      .get(caseId) as SqlRow | undefined;
    return row ? this.#mapCase(row) : null;
  }

  caseDatabasePath(caseId: string): string {
    if (!this.getCase(caseId)) throw new Error(`案件 ${caseId} 不存在`);
    return fixedCasePaths(this.dataRoot, caseId).database;
  }

  casePaths(caseId: string) {
    if (!this.getCase(caseId)) throw new Error(`案件 ${caseId} 不存在`);
    return fixedCasePaths(this.dataRoot, caseId);
  }

  registerAssignment(registration: AssignmentRegistration): void {
    const existing = this.#database
      .prepare("SELECT assignment_id FROM assignments WHERE assignment_id = ?")
      .get(registration.assignmentId);
    if (existing) throw new Error(`任务 ${registration.assignmentId} 已登记`);
    if (!this.getCase(registration.caseId)) {
      throw new Error(`案件 ${registration.caseId} 不存在`);
    }
    const existingOperator = this.#database
      .prepare(`
        SELECT public_key_spki_base64, fingerprint_sha256
        FROM operators WHERE operator_id = ? AND key_id = ?
      `)
      .get(registration.operatorId, registration.operatorKeyId) as
      | SqlRow
      | undefined;
    if (
      existingOperator &&
      (value(existingOperator, "public_key_spki_base64") !==
        registration.operatorPublicKeySpkiBase64 ||
        value(existingOperator, "fingerprint_sha256") !==
          registration.operatorFingerprint)
    ) {
      throw new Error(
        `勘察员 ${registration.operatorId} 的密钥 ${registration.operatorKeyId} 已登记为另一公钥`,
      );
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare(`
          INSERT INTO operators(
            operator_id, key_id, display_name, organization,
            public_key_spki_base64, fingerprint_sha256, registered_at_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(operator_id, key_id) DO UPDATE SET
            display_name = excluded.display_name,
            organization = excluded.organization
        `)
        .run(
          registration.operatorId,
          registration.operatorKeyId,
          registration.operatorDisplayName,
          registration.operatorOrganization,
          registration.operatorPublicKeySpkiBase64,
          registration.operatorFingerprint,
          registration.registeredAtUtc,
        );
      this.#database
        .prepare(`
          INSERT INTO assignments(
            assignment_id, case_id, operator_id, operator_key_id,
            operator_fingerprint, bundle_id, authorization_reference,
            valid_from_utc, valid_until_utc, receipt_json, registered_at_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          registration.assignmentId,
          registration.caseId,
          registration.operatorId,
          registration.operatorKeyId,
          registration.operatorFingerprint,
          registration.bundleId,
          registration.authorizationReference,
          registration.validFromUtc,
          registration.validUntilUtc,
          registration.receiptJson,
          registration.registeredAtUtc,
        );
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  findAssignment(assignmentId: string): RegisteredAssignment | null {
    const row = this.#database
      .prepare("SELECT * FROM assignments WHERE assignment_id = ?")
      .get(assignmentId) as SqlRow | undefined;
    if (!row) return null;
    return {
      assignmentId: value(row, "assignment_id"),
      caseId: value(row, "case_id"),
      operatorId: value(row, "operator_id"),
      operatorKeyId: value(row, "operator_key_id"),
      operatorFingerprint: value(row, "operator_fingerprint"),
      bundleId: value(row, "bundle_id"),
      authorizationReference: value(row, "authorization_reference"),
      validFromUtc: value(row, "valid_from_utc"),
      validUntilUtc: value(row, "valid_until_utc"),
    };
  }

  listAssignments(caseId: string): RegisteredAssignment[] {
    const rows = this.#database
      .prepare(
        "SELECT * FROM assignments WHERE case_id = ? ORDER BY registered_at_utc DESC, assignment_id",
      )
      .all(caseId) as SqlRow[];
    return rows.map((row) => ({
      assignmentId: value(row, "assignment_id"),
      caseId: value(row, "case_id"),
      operatorId: value(row, "operator_id"),
      operatorKeyId: value(row, "operator_key_id"),
      operatorFingerprint: value(row, "operator_fingerprint"),
      bundleId: value(row, "bundle_id"),
      authorizationReference: value(row, "authorization_reference"),
      validFromUtc: value(row, "valid_from_utc"),
      validUntilUtc: value(row, "valid_until_utc"),
    }));
  }

  findOperatorFingerprint(fingerprint: string): string | null {
    const row = this.#database
      .prepare(
        "SELECT fingerprint_sha256 FROM operators WHERE fingerprint_sha256 = ?",
      )
      .get(fingerprint) as SqlRow | undefined;
    return row ? value(row, "fingerprint_sha256") : null;
  }

  async refreshCaseSummary(caseId: string): Promise<CaseSummary> {
    const repository = new SqliteEvidenceRepository(this.caseDatabasePath(caseId));
    const summary = await repository.getCaseSummary();
    await repository.close();
    this.#database
      .prepare(`
        UPDATE cases SET source_count = ?, chat_count = ?, message_count = ?,
          integrity = ?, updated_at_utc = ? WHERE case_id = ?
      `)
      .run(
        summary.sourceCount,
        summary.chatCount,
        summary.messageCount,
        summary.integrity,
        new Date().toISOString(),
        caseId,
      );
    return this.getCase(caseId) ?? summary;
  }

  auditIntake(input: {
    caseId: string;
    action: string;
    evidenceId?: string;
    manifestRootSha256?: string;
    result: string;
    detailCode: string;
  }): void {
    this.#database
      .prepare(`
        INSERT INTO intake_audit(
          at_utc, case_id, action, evidence_id, manifest_root_sha256,
          result, detail_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        new Date().toISOString(),
        input.caseId,
        input.action,
        input.evidenceId ?? null,
        input.manifestRootSha256 ?? null,
        input.result,
        input.detailCode,
      );
  }

  close(): void {
    this.#database.close();
  }

  #mapCase(row: SqlRow): CaseSummary {
    const status = value(row, "status") === "archived" ? "archived" : "open";
    const integrityValue = value(row, "integrity");
    const integrity = ["verified", "partial", "failed"].includes(integrityValue)
      ? (integrityValue as "verified" | "partial" | "failed")
      : "empty";
    return {
      caseId: value(row, "case_id"),
      name: value(row, "name"),
      authorizationReference: value(row, "authorization_reference"),
      organization: value(row, "organization"),
      description: value(row, "description"),
      status,
      createdAtUtc: value(row, "created_at_utc"),
      updatedAtUtc: value(row, "updated_at_utc"),
      sourceCount: numberValue(row, "source_count"),
      chatCount: numberValue(row, "chat_count"),
      messageCount: numberValue(row, "message_count"),
      integrity,
    };
  }
}
