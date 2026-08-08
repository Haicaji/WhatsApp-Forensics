import { randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  readFileSync,
  renameSync,
  rmdirSync,
} from "node:fs";
import { copyFile, mkdir, opendir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  type ImportResult,
  type UsbIntakeResult,
  uuidSchema,
} from "@wafc/domain";
import {
  CaseImportWriter,
  type EntityImportInput,
} from "@wafc/evidence-repository/node";

import { type RegisteredAssignment, type WorkstationCatalog } from "./catalog";
import {
  assertContained,
  assertRealDirectory,
  assertRealFile,
} from "./paths";
import {
  EvidenceVerifier,
  type VerificationReport,
} from "./verifier";

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_NDJSON_LINE_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 500_000;
const MAX_ARCHIVE_BYTES = 4 * 1024 ** 4;

const NORMALIZED_DATASETS = [
  "accounts.ndjson",
  "contacts.ndjson",
  "chats.ndjson",
  "chat-lists.ndjson",
  "participants.ndjson",
  "messages.ndjson",
  "message-events.ndjson",
  "reactions.ndjson",
  "receipts.ndjson",
  "poll-votes.ndjson",
  "group-events.ndjson",
  "statuses.ndjson",
  "calls.ndjson",
  "channels.ndjson",
  "channel-events.ndjson",
  "communities.ndjson",
  "community-relations.ndjson",
  "presence-snapshots.ndjson",
] as const;

type JsonObject = Record<string, unknown>;

type AcquisitionIdentity = {
  evidenceId: string;
  sourceId: string;
  assignmentId: string;
  bundleId: string;
  operatorId: string;
  authorizationReference: string;
  authorizationConfirmedAtUtc: string;
  observationStartedAtUtc: string;
  observationEndedAtUtc: string;
};

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}不是 JSON 对象`);
  }
  return value as JsonObject;
}

function requiredObject(parent: JsonObject, key: string, label: string): JsonObject {
  return object(parent[key], `${label}.${key}`);
}

function requiredString(parent: JsonObject, key: string, label: string): string {
  const value = parent[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}.${key}缺失或类型错误`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function integer(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}

function boolean(value: unknown): boolean {
  return value === true;
}

function readJson(path: string, label: string): JsonObject {
  const file = assertRealFile(path, label);
  const metadata = lstatSync(file);
  if (metadata.size > MAX_JSON_BYTES) throw new Error(`${label}超过大小上限`);
  return object(JSON.parse(readFileSync(file, "utf8")), label);
}

async function* readNdjson(path: string): AsyncGenerator<JsonObject> {
  const file = assertRealFile(path, "NDJSON 数据集");
  const stream = createReadStream(file, { highWaterMark: 256 * 1024 });
  let buffered = Buffer.alloc(0);
  for await (const chunk of stream) {
    buffered = Buffer.concat([buffered, chunk as Buffer]);
    if (buffered.length > MAX_NDJSON_LINE_BYTES && !buffered.includes(0x0a)) {
      stream.destroy();
      throw new Error("NDJSON 单行超过大小上限");
    }
    let newline = buffered.indexOf(0x0a);
    while (newline >= 0) {
      const line = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      if (line.length > MAX_NDJSON_LINE_BYTES) {
        throw new Error("NDJSON 单行超过大小上限");
      }
      if (line.length > 0) {
        yield object(JSON.parse(line.toString("utf8")), "NDJSON 记录");
      }
      newline = buffered.indexOf(0x0a);
    }
  }
  if (buffered.length > 0) {
    if (buffered.length > MAX_NDJSON_LINE_BYTES) {
      throw new Error("NDJSON 单行超过大小上限");
    }
    yield object(JSON.parse(buffered.toString("utf8")), "NDJSON 记录");
  }
}

function acquisitionIdentity(acquisition: JsonObject): AcquisitionIdentity {
  const portable = requiredObject(
    acquisition,
    "portableConfiguration",
    "acquisition",
  );
  const operator = requiredObject(acquisition, "operator", "acquisition");
  const authorization = requiredObject(
    acquisition,
    "authorization",
    "acquisition",
  );
  const observation = requiredObject(
    acquisition,
    "observationWindow",
    "acquisition",
  );
  const evidenceId = uuidSchema.parse(
    requiredString(acquisition, "evidenceId", "acquisition"),
  );
  const sourceId = uuidSchema.parse(
    requiredString(acquisition, "sourceId", "acquisition"),
  );
  return {
    evidenceId,
    sourceId,
    assignmentId: requiredString(portable, "assignmentId", "portableConfiguration"),
    bundleId: uuidSchema.parse(
      requiredString(portable, "bundleId", "portableConfiguration"),
    ),
    operatorId: requiredString(operator, "operatorId", "operator"),
    authorizationReference: requiredString(
      authorization,
      "reference",
      "authorization",
    ),
    authorizationConfirmedAtUtc: requiredString(
      authorization,
      "confirmedAtUtc",
      "authorization",
    ),
    observationStartedAtUtc: requiredString(
      observation,
      "startedAtUtc",
      "observationWindow",
    ),
    observationEndedAtUtc: requiredString(
      observation,
      "endedAtUtc",
      "observationWindow",
    ),
  };
}

function validateAssignmentBinding(
  assignment: RegisteredAssignment,
  identity: AcquisitionIdentity,
  caseId: string,
  signerFingerprint: string,
): void {
  if (
    assignment.caseId !== caseId ||
    assignment.operatorFingerprint !== signerFingerprint ||
    assignment.operatorId !== identity.operatorId ||
    assignment.bundleId !== identity.bundleId ||
    assignment.authorizationReference !== identity.authorizationReference
  ) {
    throw new Error("Evidence Bag 与案件、任务或勘察员信任登记不一致");
  }
  const confirmed = Date.parse(identity.authorizationConfirmedAtUtc);
  if (
    !Number.isFinite(confirmed) ||
    confirmed < Date.parse(assignment.validFromUtc) ||
    confirmed >= Date.parse(assignment.validUntilUtc)
  ) {
    throw new Error("Evidence Bag 的现场授权确认时间不在已签发任务有效期内");
  }
}

async function copyVerifiedTree(source: string, destination: string): Promise<void> {
  const canonicalSource = assertRealDirectory(source, "Evidence Bag");
  mkdirSync(destination, { recursive: false });
  let fileCount = 0;
  let totalBytes = 0;

  async function copyDirectory(sourceDirectory: string, destinationDirectory: string) {
    const handle = await opendir(sourceDirectory);
    for await (const entry of handle) {
      if (
        entry.name === "." ||
        entry.name === ".." ||
        entry.name.includes("/") ||
        entry.name.includes("\\") ||
        [...entry.name].some((character) => character < " ")
      ) {
        throw new Error("Evidence Bag 包含不安全文件名");
      }
      const sourcePath = join(sourceDirectory, entry.name);
      const destinationPath = join(destinationDirectory, entry.name);
      assertContained(canonicalSource, sourcePath, "Evidence Bag 文件");
      const metadata = lstatSync(sourcePath);
      if (metadata.isSymbolicLink()) {
        throw new Error("Evidence Bag 包含符号链接或联接点");
      }
      if (metadata.isDirectory()) {
        await mkdir(destinationPath, { recursive: false });
        await copyDirectory(sourcePath, destinationPath);
      } else if (metadata.isFile()) {
        fileCount += 1;
        totalBytes += metadata.size;
        if (fileCount > MAX_ARCHIVE_FILES || totalBytes > MAX_ARCHIVE_BYTES) {
          throw new Error("Evidence Bag 超过归档文件数或总字节上限");
        }
        await copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
      } else {
        throw new Error("Evidence Bag 包含不支持的特殊文件");
      }
    }
  }

  await copyDirectory(canonicalSource, destination);
}

function compareVerification(
  expected: VerificationReport,
  archived: VerificationReport,
): void {
  if (
    expected.evidenceId !== archived.evidenceId ||
    expected.manifestRootSha256 !== archived.manifestRootSha256 ||
    expected.signature.fingerprint !== archived.signature.fingerprint
  ) {
    throw new Error("归档副本与已校验 Evidence Bag 的证据身份不一致");
  }
}

function displayNameForRecord(record: JsonObject): string | null {
  const data = requiredObject(record, "data", "record");
  if (typeof data.displayName === "string") return data.displayName;
  if (typeof data.verifiedName === "string") return data.verifiedName;
  if (typeof data.title === "string") return data.title;
  if (typeof data.name === "string") return data.name;
  if (typeof data.displayNames === "object" && data.displayNames !== null) {
    const names = data.displayNames as JsonObject;
    for (const key of ["formatted", "verified", "push", "short"]) {
      if (typeof names[key] === "string" && names[key].length > 0) {
        return names[key];
      }
    }
  }
  return null;
}

function nativeIdentityForRecord(record: JsonObject): string | null {
  const data = requiredObject(record, "data", "record");
  if (typeof data.nativeIdentity === "object" && data.nativeIdentity !== null) {
    return optionalString((data.nativeIdentity as JsonObject).opaqueValue);
  }
  if (Array.isArray(data.nativeIdentities)) {
    for (const identity of data.nativeIdentities) {
      if (typeof identity === "object" && identity !== null) {
        const value = optionalString((identity as JsonObject).opaqueValue);
        if (value) return value;
      }
    }
  }
  return null;
}

function envelopeEntity(record: JsonObject): EntityImportInput {
  return {
    recordId: requiredString(record, "recordId", "record"),
    sourceId: requiredString(record, "sourceId", "record"),
    recordType: requiredString(record, "recordType", "record"),
    displayName: displayNameForRecord(record),
    nativeIdentity: nativeIdentityForRecord(record),
    contentSha256: requiredString(record, "contentSha256", "record"),
    json: JSON.stringify(record),
  };
}

export class EvidenceIntakeService {
  readonly #catalog: WorkstationCatalog;
  readonly #verifier: EvidenceVerifier;

  constructor(input: {
    catalog: WorkstationCatalog;
    verifierExecutable: string;
  }) {
    this.#catalog = input.catalog;
    this.#verifier = new EvidenceVerifier(input.verifierExecutable);
  }

  async importEvidence(caseId: string, bagPath: string): Promise<ImportResult> {
    const caseSummary = this.#catalog.getCase(caseId);
    if (!caseSummary) throw new Error(`案件 ${caseId} 不存在`);
    const sourceBag = assertRealDirectory(bagPath, "Evidence Bag");
    const initialReport = await this.#verifier.verify(sourceBag);
    const registeredFingerprint = this.#catalog.findOperatorFingerprint(
      initialReport.signature.fingerprint,
    );
    if (!registeredFingerprint) {
      this.#catalog.auditIntake({
        caseId,
        action: "verify_source",
        evidenceId: initialReport.evidenceId,
        manifestRootSha256: initialReport.manifestRootSha256,
        result: "rejected",
        detailCode: "unknown_operator_fingerprint",
      });
      throw new Error("Evidence Bag 签名密钥未在当前 Workstation 登记，已拒绝导入");
    }
    const trustedReport = await this.#verifier.verify(
      sourceBag,
      registeredFingerprint,
    );
    compareVerification(initialReport, trustedReport);

    const acquisition = readJson(
      join(sourceBag, "data", "acquisition.json"),
      "acquisition.json",
    );
    const identity = acquisitionIdentity(acquisition);
    if (identity.evidenceId !== trustedReport.evidenceId) {
      throw new Error("校验报告与 acquisition.json 的 evidenceId 不一致");
    }
    const assignment = this.#catalog.findAssignment(identity.assignmentId);
    if (!assignment) throw new Error("Evidence Bag 引用的任务未在 Workstation 登记");
    validateAssignmentBinding(
      assignment,
      identity,
      caseId,
      trustedReport.signature.fingerprint,
    );

    const paths = this.#catalog.casePaths(caseId);
    const lookupWriter = new CaseImportWriter(paths.database);
    const existing = lookupWriter.findEvidence(identity.evidenceId);
    lookupWriter.close();
    if (existing) {
      if (existing.manifestRootSha256 !== trustedReport.manifestRootSha256) {
        throw new Error("相同 evidenceId 已导入，但 manifest root 不同");
      }
      return {
        caseId,
        evidenceId: identity.evidenceId,
        sourceId: existing.sourceId,
        manifestRootSha256: existing.manifestRootSha256,
        status: "already_imported",
        chatCount: existing.chatCount,
        messageCount: existing.messageCount,
      };
    }

    const archivedBag = join(paths.sources, basename(sourceBag));
    let archiveReport: VerificationReport;
    if (existsSync(archivedBag)) {
      archiveReport = await this.#verifier.verify(
        assertRealDirectory(archivedBag, "已归档 Evidence Bag"),
        registeredFingerprint,
      );
      compareVerification(trustedReport, archiveReport);
    } else {
      const partialParent = join(
        paths.sources,
        `.${identity.evidenceId}.partial-${randomUUID()}`,
      );
      mkdirSync(partialParent, { recursive: false });
      const partialBag = join(partialParent, basename(sourceBag));
      await copyVerifiedTree(sourceBag, partialBag);
      archiveReport = await this.#verifier.verify(
        partialBag,
        registeredFingerprint,
      );
      compareVerification(trustedReport, archiveReport);
      if (existsSync(archivedBag)) {
        throw new Error("Evidence Bag 归档目标在复制期间被其他程序创建");
      }
      renameSync(partialBag, archivedBag);
      rmdirSync(partialParent);
    }

    const writer = new CaseImportWriter(paths.database);
    try {
      const counts = await this.#importNormalized(
        caseId,
        archivedBag,
        identity,
        acquisition,
        archiveReport,
        writer,
      );
      await this.#catalog.refreshCaseSummary(caseId);
      this.#catalog.auditIntake({
        caseId,
        action: "archive_and_import",
        evidenceId: identity.evidenceId,
        manifestRootSha256: archiveReport.manifestRootSha256,
        result: "accepted",
        detailCode: "trusted_idempotent_import_complete",
      });
      return {
        caseId,
        evidenceId: identity.evidenceId,
        sourceId: identity.sourceId,
        manifestRootSha256: archiveReport.manifestRootSha256,
        status: "imported",
        chatCount: counts.chatCount,
        messageCount: counts.messageCount,
      };
    } catch (error) {
      writer.rollback();
      this.#catalog.auditIntake({
        caseId,
        action: "archive_and_import",
        evidenceId: identity.evidenceId,
        manifestRootSha256: archiveReport.manifestRootSha256,
        result: "failed",
        detailCode: "derived_import_failed",
      });
      throw error;
    } finally {
      writer.close();
    }
  }

  async intakeUsb(caseId: string, usbRoot: string): Promise<UsbIntakeResult> {
    const root = assertRealDirectory(usbRoot, "U 盘根目录");
    const sealed = assertRealDirectory(
      join(root, "Field Collector", "evidence", "sealed"),
      "U 盘已封存证据目录",
    );
    const imported: ImportResult[] = [];
    const skipped: UsbIntakeResult["skipped"] = [];
    const directory = opendirSync(sealed);
    try {
      for (;;) {
        const entry = directory.readSync();
        if (!entry) break;
        if (!entry.isDirectory() || !entry.name.startsWith("waeb-")) continue;
        const bag = join(sealed, entry.name);
        try {
          imported.push(await this.importEvidence(caseId, bag));
        } catch (error) {
          skipped.push({
            path: entry.name,
            reason: error instanceof Error ? error.message : "Evidence Bag 导入失败",
          });
        }
      }
    } finally {
      directory.closeSync();
    }
    return { imported, skipped };
  }

  async intakeUsbAutomatically(usbRoot: string): Promise<UsbIntakeResult> {
    const root = assertRealDirectory(usbRoot, "U 盘根目录");
    const sealed = assertRealDirectory(
      join(root, "Field Collector", "evidence", "sealed"),
      "U 盘已封存证据目录",
    );
    const imported: ImportResult[] = [];
    const skipped: UsbIntakeResult["skipped"] = [];
    const entries = [];
    const directory = opendirSync(sealed);
    try {
      for (;;) {
        const entry = directory.readSync();
        if (!entry) break;
        if (entry.isDirectory() && entry.name.startsWith("waeb-")) {
          entries.push(entry.name);
        }
      }
    } finally {
      directory.closeSync();
    }
    entries.sort((left, right) => left.localeCompare(right, "en"));
    for (const entry of entries) {
      const bag = join(sealed, entry);
      try {
        const report = await this.#verifier.verify(bag);
        const registeredFingerprint = this.#catalog.findOperatorFingerprint(
          report.signature.fingerprint,
        );
        if (!registeredFingerprint) {
          throw new Error("签名密钥未在当前 Workstation 登记");
        }
        const trusted = await this.#verifier.verify(
          bag,
          registeredFingerprint,
        );
        compareVerification(report, trusted);
        const acquisition = readJson(
          join(bag, "data", "acquisition.json"),
          "acquisition.json",
        );
        const identity = acquisitionIdentity(acquisition);
        if (identity.evidenceId !== trusted.evidenceId) {
          throw new Error("校验报告与 acquisition.json 的 evidenceId 不一致");
        }
        const assignment = this.#catalog.findAssignment(identity.assignmentId);
        if (!assignment) {
          throw new Error("Evidence Bag 引用的任务未在 Workstation 登记");
        }
        validateAssignmentBinding(
          assignment,
          identity,
          assignment.caseId,
          trusted.signature.fingerprint,
        );
        imported.push(await this.importEvidence(assignment.caseId, bag));
      } catch (error) {
        skipped.push({
          path: entry,
          reason: error instanceof Error ? error.message : "Evidence Bag 导入失败",
        });
      }
    }
    return { imported, skipped };
  }

  async #importNormalized(
    caseId: string,
    bag: string,
    identity: AcquisitionIdentity,
    acquisition: JsonObject,
    verification: VerificationReport,
    writer: CaseImportWriter,
  ) {
    const completeness = readJson(
      join(bag, "data", "completeness.json"),
      "completeness.json",
    );
    const inventory = readJson(
      join(bag, "data", "dataset-inventory.json"),
      "dataset-inventory.json",
    );
    const localSnapshot = requiredString(
      completeness,
      "localSnapshot",
      "completeness",
    );
    if (!["verified", "partial", "failed"].includes(localSnapshot)) {
      throw new Error("completeness.localSnapshot 无效");
    }
    const historyScope = requiredString(
      completeness,
      "historyScope",
      "completeness",
    );
    const mediaScope = requiredString(
      completeness,
      "mediaScope",
      "completeness",
    );
    const chatTitles = new Map<string, string>();
    const displayNames = new Map<string, string>();
    let accountCount = 0;
    let contactCount = 0;
    let chatCount = 0;
    let messageCount = 0;
    let attachmentCount = 0;
    const normalizedRoot = join(bag, "data", "normalized");

    writer.begin();
    writer.insertSource({
      sourceId: identity.sourceId,
      evidenceId: identity.evidenceId,
      assignmentId: identity.assignmentId,
      operatorId: identity.operatorId,
      signerFingerprint: verification.signature.fingerprint,
      manifestRootSha256: verification.manifestRootSha256,
      bagPath: bag,
      importedAtUtc: new Date().toISOString(),
      observationStartedAtUtc: identity.observationStartedAtUtc,
      observationEndedAtUtc: identity.observationEndedAtUtc,
      localSnapshot: localSnapshot as "verified" | "partial" | "failed",
      historyScope,
      mediaScope,
      unresolvedReferences: 0,
    });

    for (const dataset of NORMALIZED_DATASETS) {
      if (dataset === "chats.ndjson" || dataset === "messages.ndjson") continue;
      for await (const record of readNdjson(join(normalizedRoot, dataset))) {
        const entity = envelopeEntity(record);
        if (entity.sourceId !== identity.sourceId) {
          throw new Error("normalized 记录 sourceId 与 acquisition 不一致");
        }
        writer.insertEntity(entity);
        if (entity.displayName) displayNames.set(entity.recordId, entity.displayName);
        if (entity.recordType === "account") accountCount += 1;
        if (entity.recordType === "contact") contactCount += 1;
      }
    }

    for await (const record of readNdjson(join(normalizedRoot, "chats.ndjson"))) {
      const data = requiredObject(record, "data", "chat");
      const recordId = requiredString(record, "recordId", "chat");
      const sourceId = requiredString(record, "sourceId", "chat");
      const title = requiredString(data, "title", "chat.data");
      if (sourceId !== identity.sourceId) {
        throw new Error("chat sourceId 与 acquisition 不一致");
      }
      const state = requiredObject(data, "state", "chat.data");
      writer.insertChat({
        recordId,
        sourceId,
        title,
        kind: requiredString(data, "kind", "chat.data"),
        unreadCount: integer(state.unreadCount),
        firstObservedAtUtc: optionalString(data.firstObservedAtUtc),
        lastObservedAtUtc: optionalString(data.lastObservedAtUtc),
        contentSha256: requiredString(record, "contentSha256", "chat"),
        json: JSON.stringify(record),
      });
      chatTitles.set(recordId, title);
      chatCount += 1;
    }

    for await (const record of readNdjson(join(normalizedRoot, "messages.ndjson"))) {
      const data = requiredObject(record, "data", "message");
      const container = requiredObject(data, "container", "message.data");
      const chatRecordId = requiredString(container, "recordId", "message.container");
      const chatTitle = chatTitles.get(chatRecordId);
      if (!chatTitle) throw new Error("message 引用了不存在的 chat");
      const senderRecordId = optionalString(data.senderRecordId);
      const sentAt = requiredObject(data, "sentAt", "message.data");
      const flags = requiredObject(data, "flags", "message.data");
      const attachments = Array.isArray(data.attachmentAssetIds)
        ? data.attachmentAssetIds
        : [];
      writer.insertMessage({
        recordId: requiredString(record, "recordId", "message"),
        sourceId: requiredString(record, "sourceId", "message"),
        chatRecordId,
        senderRecordId,
        senderDisplayName: senderRecordId
          ? displayNames.get(senderRecordId) ?? null
          : null,
        chatTitle,
        sentAtUtc: optionalString(sentAt.utc),
        kind: requiredString(data, "kind", "message.data"),
        text: optionalString(data.text),
        caption: optionalString(data.caption),
        fromMe: boolean(flags.fromMe),
        edited: boolean(flags.edited),
        revoked: boolean(flags.revoked),
        starred: boolean(flags.starred),
        forwarded: boolean(flags.forwarded),
        attachmentCount: attachments.length,
        contentSha256: requiredString(record, "contentSha256", "message"),
        json: JSON.stringify(record),
      });
      messageCount += 1;
    }

    for await (const media of readNdjson(
      join(bag, "data", "indexes", "media.ndjson"),
    )) {
      const cas =
        typeof media.cas === "object" && media.cas !== null
          ? (media.cas as JsonObject)
          : null;
      writer.insertAttachment({
        assetId: requiredString(media, "assetId", "media"),
        sourceId: requiredString(media, "sourceId", "media"),
        mediaRole: requiredString(media, "role", "media"),
        mimeType: optionalString(media.detectedMime ?? media.declaredMime),
        byteLength: cas ? integer(cas.byteLength, 0) : null,
        sha256: cas ? optionalString(cas.digest) : null,
        casPath: cas ? optionalString(cas.path) : null,
        sourceRecordIdsJson: JSON.stringify(
          Array.isArray(media.sourceRecordIds) ? media.sourceRecordIds : [],
        ),
        json: JSON.stringify(media),
      });
      attachmentCount += 1;
    }

    writer.insertIntegrityDocuments({
      sourceId: identity.sourceId,
      completenessJson: JSON.stringify(completeness),
      inventoryJson: JSON.stringify(inventory),
      verifierJson: JSON.stringify(verification),
    });
    writer.finalizeSource(identity.sourceId, {
      accountCount,
      contactCount,
      chatCount,
      messageCount,
      attachmentCount,
    });
    writer.commit();
    void caseId;
    void acquisition;
    return {
      accountCount,
      contactCount,
      chatCount,
      messageCount,
      attachmentCount,
    };
  }
}
