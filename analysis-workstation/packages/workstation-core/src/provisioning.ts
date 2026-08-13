import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, resolve } from "node:path";

import {
  type InitializeWorkstationInput,
  type InspectUsbSoftwareInput,
  type ProvisionUsbInput,
  type ProvisioningReceipt,
  type UpdateUsbSoftwareInput,
  type UsbSoftwareInspection,
  type UsbSoftwareUpdateResult,
  type WorkstationProfile,
  initializeWorkstationInputSchema,
  inspectUsbSoftwareInputSchema,
  provisionUsbInputSchema,
  provisioningReceiptSchema,
  updateUsbSoftwareInputSchema,
  usbSoftwareInspectionSchema,
  usbSoftwareUpdateResultSchema,
  workstationProfileSchema,
} from "@wafc/domain";
import { z } from "zod";

import { type WorkstationCatalog } from "./catalog";
import {
  assertContained,
  assertRealDirectory,
  assertRealFile,
} from "./paths";
import { runJsonRpc } from "./process";

const COLLECTOR_DIRECTORY_NAME = "Field Collector";
const UPDATE_JOURNAL_NAME = ".Field Collector.software-update.json";
const PRESERVED_PORTABLE_ENTRIES = [
  "wafc-portable.json",
  "config",
  "assignments",
  "evidence",
  "handoff",
  "diagnostics",
] as const;
const PRESERVED_RESULT_ENTRIES = [
  "wafc-portable.json",
  "config/operator-profile.json",
  "config/operator-key.enc",
  "config/workstation-trust.json",
  "config/bundle-manifest.json",
  "assignments/",
  "evidence/",
  "handoff/",
  "diagnostics/",
] as const;

const releaseManifestSchema = z.object({
  schemaVersion: z.string().min(1).max(120),
  releaseVersion: z.string().min(1).max(80),
  source: z.object({
    publishable: z.boolean(),
  }),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(240),
        bytes: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/u),
      }),
    )
    .min(2)
    .max(256),
});

const portableBundleInspectionSchema = z.object({
  schemaVersion: z.literal("wafc-portable-bundle-inspection/1"),
  bundleId: z.uuid(),
  operatorId: z.string().min(3).max(80),
  operatorDisplayName: z.string().min(1).max(160),
  operatorKeyId: z.string().min(3).max(120),
  operatorKeyFingerprintSha256: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/u),
  workstationKeyFingerprintSha256: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/u),
  portableManifestSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  assignmentIds: z.array(z.string().min(3).max(120)).min(1).max(1000),
});

const softwareUpdateJournalSchema = z.object({
  schemaVersion: z.literal("wafc-software-update-journal/1"),
  transactionId: z.uuid(),
  state: z.enum(["prepared", "old_renamed", "new_activated", "data_moved"]),
  previousReleaseVersion: z.string().min(1).max(80),
  newReleaseVersion: z.string().min(1).max(80),
});

type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

type ValidatedRelease = {
  root: string;
  manifestPath: string;
  manifestSha256: string;
  manifest: ReleaseManifest;
  filePaths: string[];
};

const operatorRegistrySchema = z.object({
  schemaVersion: z.literal("wafc-operator-registry-entry/1"),
  operatorId: z.string(),
  displayName: z.string(),
  organization: z.string(),
  keyId: z.string(),
  publicKeySpkiBase64: z.string().min(1),
  fingerprintSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  createdAtUtc: z.string(),
});

export type ProvisionUsbResult = ProvisioningReceipt & {
  collectorDirectory: string;
  releasePublishable: boolean;
};

function readJsonLimited(path: string, maxBytes = 2 * 1024 * 1024): unknown {
  const file = assertRealFile(path, "JSON 文件");
  const metadata = lstatSync(file);
  if (metadata.size > maxBytes) throw new Error("JSON 文件超过大小上限");
  return JSON.parse(readFileSync(file, "utf8"));
}

function validateReleasePath(path: string): string {
  if (
    path.includes("\\") ||
    path.startsWith("/") ||
    path.includes(":") ||
    posix.normalize(path) !== path ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`发行清单包含不安全路径：${path}`);
  }
  return path;
}

function sha256File(path: string): string {
  const bytes = readFileSync(path);
  return createHash("sha256").update(bytes).digest("hex");
}

function validateReleasePayload(
  releaseRoot: string,
  label: string,
): ValidatedRelease {
  const source = assertRealDirectory(releaseRoot, "Field Collector 发行目录");
  const manifestSource = join(source, "release-manifest.json");
  const manifest = releaseManifestSchema.parse(readJsonLimited(manifestSource));
  const seen = new Set<string>();
  for (const entry of manifest.files) {
    const relativePath = validateReleasePath(entry.path);
    if (relativePath === "release-manifest.json" || seen.has(relativePath)) {
      throw new Error("发行清单包含自身或重复路径");
    }
    const topLevel = relativePath.split("/")[0];
    if (
      topLevel &&
      PRESERVED_PORTABLE_ENTRIES.includes(
        topLevel as (typeof PRESERVED_PORTABLE_ENTRIES)[number],
      )
    ) {
      throw new Error(`发行清单不得覆盖任务或证据路径：${relativePath}`);
    }
    seen.add(relativePath);
    const sourceFile = resolve(source, ...relativePath.split("/"));
    assertContained(source, sourceFile, "发行文件");
    assertRealFile(sourceFile, "发行文件");
    const metadata = lstatSync(sourceFile);
    if (metadata.size !== entry.bytes || sha256File(sourceFile) !== entry.sha256) {
      throw new Error(`${label}文件与清单不一致：${relativePath}`);
    }
  }
  if (!seen.has("field-collector.exe") || !seen.has("waeb-verify.exe")) {
    throw new Error("发行清单缺少 Field Collector 或独立校验器");
  }
  if (!seen.has("extension/manifest.json")) {
    throw new Error("发行清单缺少只读取证扩展");
  }
  return {
    root: source,
    manifestPath: assertRealFile(manifestSource, `${label}发行清单`),
    manifestSha256: sha256File(manifestSource),
    manifest,
    filePaths: [...seen].sort(),
  };
}

function copyReleasePayload(
  releaseRoot: string,
  destination: string,
): ValidatedRelease {
  const release = validateReleasePayload(releaseRoot, "Field Collector 发行");
  mkdirSync(destination, { recursive: false });
  const destinationRoot = assertRealDirectory(destination, "U 盘临时发行目录");
  for (const entry of release.manifest.files) {
    const relativePath = validateReleasePath(entry.path);
    const sourceFile = resolve(release.root, ...relativePath.split("/"));
    const destinationFile = resolve(
      destinationRoot,
      ...relativePath.split("/"),
    );
    assertContained(destinationRoot, destinationFile, "U 盘发行文件");
    mkdirSync(dirname(destinationFile), { recursive: true });
    const destinationParent = assertRealDirectory(
      dirname(destinationFile),
      "U 盘发行文件父目录",
    );
    assertContained(destinationRoot, destinationParent, "U 盘发行文件父目录");
    copyFileSync(sourceFile, destinationFile, fsConstants.COPYFILE_EXCL);
    if (sha256File(destinationFile) !== entry.sha256) {
      throw new Error(`U 盘写入后哈希不一致：${relativePath}`);
    }
  }
  const destinationManifest = join(destinationRoot, "release-manifest.json");
  copyFileSync(
    release.manifestPath,
    destinationManifest,
    fsConstants.COPYFILE_EXCL,
  );
  if (sha256File(destinationManifest) !== release.manifestSha256) {
    throw new Error("U 盘发行清单写入后哈希不一致");
  }
  validateReleasePayload(destinationRoot, "U 盘暂存发行");
  return release;
}

function collectManagedFiles(
  root: string,
  relativePath: string,
  output: Set<string>,
): void {
  const target = resolve(root, ...relativePath.split("/"));
  assertContained(root, target, "已部署软件路径");
  const metadata = lstatSync(target);
  if (metadata.isSymbolicLink()) {
    throw new Error(`已部署软件包含符号链接或联接点：${relativePath}`);
  }
  if (metadata.isFile()) {
    output.add(relativePath);
    return;
  }
  if (!metadata.isDirectory()) {
    throw new Error(`已部署软件包含不支持的文件类型：${relativePath}`);
  }
  for (const entry of readdirSync(target).sort()) {
    collectManagedFiles(root, `${relativePath}/${entry}`, output);
  }
}

function validateDeployedSoftwareLayout(
  collectorRoot: string,
  release: ValidatedRelease,
): void {
  const expected = new Set([...release.filePaths, "release-manifest.json"]);
  const managedTopLevels = new Set(
    [...expected].map((relativePath) => relativePath.split("/")[0]),
  );
  const actual = new Set<string>();
  for (const entry of readdirSync(collectorRoot).sort()) {
    if (
      PRESERVED_PORTABLE_ENTRIES.includes(
        entry as (typeof PRESERVED_PORTABLE_ENTRIES)[number],
      )
    ) {
      continue;
    }
    if (!managedTopLevels.has(entry)) {
      throw new Error(
        `Field Collector 目录含有无法安全归类的文件：${entry}；为避免误删，软件更新已停止`,
      );
    }
    collectManagedFiles(collectorRoot, entry, actual);
  }
  if (
    actual.size !== expected.size ||
    [...expected].some((relativePath) => !actual.has(relativePath))
  ) {
    throw new Error("已部署软件目录与其发行清单不一致，已拒绝覆盖更新");
  }
}

function journalPaths(usbRoot: string, transactionId: string) {
  const collector = join(usbRoot, COLLECTOR_DIRECTORY_NAME);
  const staging = join(
    usbRoot,
    `.${COLLECTOR_DIRECTORY_NAME}.software-update.${transactionId}.partial`,
  );
  const backup = join(
    usbRoot,
    `.${COLLECTOR_DIRECTORY_NAME}.software-update.${transactionId}.backup`,
  );
  const journal = join(usbRoot, UPDATE_JOURNAL_NAME);
  for (const path of [collector, staging, backup, journal]) {
    assertContained(usbRoot, path, "U 盘软件更新路径");
  }
  return { collector, staging, backup, journal };
}

function writeUpdateJournal(
  path: string,
  document: z.infer<typeof softwareUpdateJournalSchema>,
  create: boolean,
): void {
  const parsed = softwareUpdateJournalSchema.parse(document);
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, {
    encoding: "utf8",
    flag: create ? "wx" : "w",
    flush: true,
  });
}

function recoverInterruptedSoftwareUpdate(usbRoot: string): void {
  const journalPath = join(usbRoot, UPDATE_JOURNAL_NAME);
  if (!existsSync(journalPath)) return;
  const journal = softwareUpdateJournalSchema.parse(
    readJsonLimited(journalPath, 64 * 1024),
  );
  const paths = journalPaths(usbRoot, journal.transactionId);
  if (existsSync(paths.backup)) {
    const backup = assertRealDirectory(paths.backup, "软件更新备份目录");
    if (existsSync(paths.collector)) {
      const collector = assertRealDirectory(
        paths.collector,
        "软件更新中的 Field Collector 目录",
      );
      for (const entry of PRESERVED_PORTABLE_ENTRIES) {
        const currentEntry = join(collector, entry);
        const backupEntry = join(backup, entry);
        if (existsSync(currentEntry) && existsSync(backupEntry)) {
          throw new Error(`软件更新恢复发现重复的保留路径：${entry}`);
        }
        if (existsSync(currentEntry)) renameSync(currentEntry, backupEntry);
      }
      rmSync(collector, { recursive: true, force: false });
    }
    renameSync(backup, paths.collector);
  } else if (!existsSync(paths.collector)) {
    throw new Error("检测到未完成的软件更新，但原 Field Collector 目录与备份均不存在");
  }
  if (existsSync(paths.staging)) {
    const staging = assertRealDirectory(paths.staging, "软件更新暂存目录");
    rmSync(staging, { recursive: true, force: false });
  }
  rmSync(paths.journal, { force: false });
}

function cleanupCommittedSoftwareBackups(usbRoot: string): void {
  const backupPattern =
    /^\.Field Collector\.software-update\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.backup$/u;
  for (const entry of readdirSync(usbRoot)) {
    if (!backupPattern.test(entry)) continue;
    const backup = assertRealDirectory(
      join(usbRoot, entry),
      "已提交软件更新的旧版本备份",
    );
    if (
      PRESERVED_PORTABLE_ENTRIES.some((preserved) =>
        existsSync(join(backup, preserved)),
      )
    ) {
      throw new Error(
        "发现缺少事务日志且仍包含任务或证据数据的软件更新备份，已停止自动处理",
      );
    }
    try {
      rmSync(backup, { recursive: true, force: false });
    } catch {
      // A previously launched Collector may still hold the old executable.
      // Leaving this software-only backup is safer than treating cleanup as an
      // update failure; the next inspection retries after the process closes.
    }
  }
}

function rollbackSoftwareUpdate(
  paths: ReturnType<typeof journalPaths>,
): void {
  if (existsSync(paths.backup)) {
    const backup = assertRealDirectory(paths.backup, "软件更新备份目录");
    if (existsSync(paths.collector)) {
      const collector = assertRealDirectory(
        paths.collector,
        "更新失败后的 Field Collector 目录",
      );
      for (const entry of PRESERVED_PORTABLE_ENTRIES) {
        const currentEntry = join(collector, entry);
        const backupEntry = join(backup, entry);
        if (existsSync(currentEntry) && !existsSync(backupEntry)) {
          renameSync(currentEntry, backupEntry);
        }
      }
      rmSync(collector, { recursive: true, force: false });
    }
    renameSync(backup, paths.collector);
  }
  if (existsSync(paths.staging)) {
    const staging = assertRealDirectory(paths.staging, "软件更新暂存目录");
    rmSync(staging, { recursive: true, force: false });
  }
  if (existsSync(paths.journal)) rmSync(paths.journal, { force: false });
}

export class ProvisioningService {
  readonly #catalog: WorkstationCatalog;
  readonly #provisionerExecutable: string;
  readonly #collectorReleaseDirectory: string;

  constructor(input: {
    catalog: WorkstationCatalog;
    provisionerExecutable: string;
    collectorReleaseDirectory: string;
  }) {
    this.#catalog = input.catalog;
    this.#provisionerExecutable = assertRealFile(
      input.provisionerExecutable,
      "USB Provisioner",
    );
    this.#collectorReleaseDirectory = assertRealDirectory(
      input.collectorReleaseDirectory,
      "Field Collector 发行目录",
    );
  }

  getWorkstationProfile(): WorkstationProfile | null {
    const profilePath = join(
      this.#catalog.provisioningStateDir,
      "workstation-profile.json",
    );
    if (!existsSync(profilePath)) return null;
    return workstationProfileSchema.parse(readJsonLimited(profilePath));
  }

  async initializeWorkstation(
    input: InitializeWorkstationInput,
  ): Promise<WorkstationProfile> {
    const parsed = initializeWorkstationInputSchema.parse(input);
    if (parsed.passphrase !== parsed.passphraseConfirmation) {
      throw new Error("两次 Workstation 密钥口令不一致");
    }
    if (this.getWorkstationProfile()) {
      throw new Error("Workstation 配置签名身份已经初始化");
    }
    return workstationProfileSchema.parse(
      await runJsonRpc<unknown>(this.#provisionerExecutable, {
        method: "initializeWorkstation",
        stateDir: this.#catalog.provisioningStateDir,
        workstationId: parsed.workstationId,
        keyId: parsed.keyId,
        passphrase: parsed.passphrase,
        createdAtUtc: new Date().toISOString(),
      }),
    );
  }

  async inspectUsbSoftware(
    input: InspectUsbSoftwareInput,
  ): Promise<UsbSoftwareInspection> {
    const parsed = inspectUsbSoftwareInputSchema.parse(input);
    return (await this.#inspectUsbSoftware(parsed)).inspection;
  }

  async updateUsbSoftware(
    input: UpdateUsbSoftwareInput,
  ): Promise<UsbSoftwareUpdateResult> {
    const parsed = updateUsbSoftwareInputSchema.parse(input);
    const initial = await this.#inspectUsbSoftware(parsed);
    const updatedAtUtc = new Date().toISOString();
    if (!initial.inspection.updateNeeded) {
      return usbSoftwareUpdateResultSchema.parse({
        ...initial.inspection,
        schemaVersion: "wafc-usb-software-update-result/1",
        status: "already_current",
        previousReleaseVersion: initial.currentRelease.manifest.releaseVersion,
        newReleaseVersion: initial.availableRelease.manifest.releaseVersion,
        installedFileCount: 0,
        removedFileCount: 0,
        preservedEntries: [...PRESERVED_RESULT_ENTRIES],
        updateReceiptPath: null,
        cleanupPending: false,
        retainedBackupPath: null,
        updatedAtUtc,
      });
    }

    const transactionId = randomUUID();
    const paths = journalPaths(initial.usbRoot, transactionId);
    if (
      existsSync(paths.staging) ||
      existsSync(paths.backup) ||
      existsSync(paths.journal)
    ) {
      throw new Error("U 盘中存在另一项未完成的软件更新");
    }
    const journal = {
      schemaVersion: "wafc-software-update-journal/1" as const,
      transactionId,
      state: "prepared" as const,
      previousReleaseVersion: initial.currentRelease.manifest.releaseVersion,
      newReleaseVersion: initial.availableRelease.manifest.releaseVersion,
    };
    try {
      writeUpdateJournal(paths.journal, journal, true);
      copyReleasePayload(this.#collectorReleaseDirectory, paths.staging);
    } catch (error) {
      if (existsSync(paths.staging)) {
        const staging = assertRealDirectory(paths.staging, "软件更新暂存目录");
        rmSync(staging, { recursive: true, force: false });
      }
      if (existsSync(paths.journal)) rmSync(paths.journal, { force: false });
      throw error;
    }

    let committed = false;
    try {
      renameSync(paths.collector, paths.backup);
      writeUpdateJournal(
        paths.journal,
        { ...journal, state: "old_renamed" },
        false,
      );
      renameSync(paths.staging, paths.collector);
      writeUpdateJournal(
        paths.journal,
        { ...journal, state: "new_activated" },
        false,
      );
      for (const entry of PRESERVED_PORTABLE_ENTRIES) {
        const source = join(paths.backup, entry);
        const destination = join(paths.collector, entry);
        if (!existsSync(source) || existsSync(destination)) {
          throw new Error(`无法安全转移保留数据：${entry}`);
        }
        renameSync(source, destination);
      }
      writeUpdateJournal(
        paths.journal,
        { ...journal, state: "data_moved" },
        false,
      );

      const verifiedPortable = await this.#inspectPortableBundle(paths.collector);
      if (
        verifiedPortable.bundleId !== initial.portable.bundleId ||
        verifiedPortable.portableManifestSha256 !==
          initial.portable.portableManifestSha256 ||
        verifiedPortable.operatorKeyFingerprintSha256 !==
          initial.portable.operatorKeyFingerprintSha256
      ) {
        throw new Error("软件更新后任务、勘察员密钥或便携配置身份发生变化");
      }
      const installedRelease = validateReleasePayload(
        paths.collector,
        "更新后的 Field Collector",
      );
      validateDeployedSoftwareLayout(paths.collector, installedRelease);
      if (
        installedRelease.manifestSha256 !==
        initial.availableRelease.manifestSha256
      ) {
        throw new Error("软件更新后发行清单与 Workstation 内置版本不一致");
      }

      rmSync(paths.journal, { force: false });
      committed = true;
    } catch (error) {
      if (!committed) {
        try {
          rollbackSoftwareUpdate(paths);
        } catch (rollbackError) {
          throw new Error(
            `${error instanceof Error ? error.message : "软件更新失败"}；自动回滚也失败：${
              rollbackError instanceof Error ? rollbackError.message : "未知错误"
            }。请保留 U 盘并交由技术人员恢复，切勿删除 .backup/.partial 目录。`,
          );
        }
      }
      throw error;
    }

    let cleanupPending = false;
    try {
      rmSync(paths.backup, { recursive: true, force: false });
    } catch {
      cleanupPending = true;
    }

    let updateReceiptPath: string | null = null;
    try {
      const diagnostics = assertRealDirectory(
        join(paths.collector, "diagnostics"),
        "U 盘诊断目录",
      );
      const updates = join(diagnostics, "software-updates");
      if (!existsSync(updates)) mkdirSync(updates, { recursive: false });
      const updatesRoot = assertRealDirectory(updates, "软件更新记录目录");
      updateReceiptPath = join(updatesRoot, `software-update-${transactionId}.json`);
      assertContained(updatesRoot, updateReceiptPath, "软件更新记录");
      writeFileSync(
        updateReceiptPath,
        `${JSON.stringify(
          {
            schemaVersion: "wafc-software-update-receipt/1",
            transactionId,
            bundleId: initial.portable.bundleId,
            previousReleaseVersion:
              initial.currentRelease.manifest.releaseVersion,
            newReleaseVersion: initial.availableRelease.manifest.releaseVersion,
            previousManifestSha256: initial.currentRelease.manifestSha256,
            newManifestSha256: initial.availableRelease.manifestSha256,
            preservedEntries: PRESERVED_RESULT_ENTRIES,
            updatedAtUtc,
          },
          null,
          2,
        )}\n`,
        { encoding: "utf8", flag: "wx", flush: true },
      );
    } catch {
      updateReceiptPath = null;
    }

    const removedFileCount = initial.currentRelease.filePaths.filter(
      (path) => !initial.availableRelease.filePaths.includes(path),
    ).length;
    return usbSoftwareUpdateResultSchema.parse({
      ...initial.inspection,
      schemaVersion: "wafc-usb-software-update-result/1",
      status: "updated",
      currentReleaseVersion: initial.availableRelease.manifest.releaseVersion,
      updateNeeded: false,
      previousReleaseVersion: initial.currentRelease.manifest.releaseVersion,
      newReleaseVersion: initial.availableRelease.manifest.releaseVersion,
      installedFileCount: initial.availableRelease.filePaths.length + 1,
      removedFileCount,
      preservedEntries: [...PRESERVED_RESULT_ENTRIES],
      updateReceiptPath,
      cleanupPending,
      retainedBackupPath: cleanupPending ? paths.backup : null,
      updatedAtUtc,
    });
  }

  async provisionUsb(input: ProvisionUsbInput): Promise<ProvisionUsbResult> {
    const parsed = provisionUsbInputSchema.parse(input);
    if (parsed.operatorPassphrase !== parsed.operatorPassphraseConfirmation) {
      throw new Error("两次勘察员密钥口令不一致");
    }
    const caseSummary = this.#catalog.getCase(parsed.caseId);
    if (!caseSummary) throw new Error(`案件 ${parsed.caseId} 不存在`);
    if (
      parsed.assignment.authorizationReference !==
        caseSummary.authorizationReference ||
      parsed.assignment.sourceOrganization !== caseSummary.organization
    ) {
      throw new Error("任务授权引用或来源机构与案件不一致");
    }
    const validFrom = new Date(parsed.assignment.validFromUtc);
    const validUntil = new Date(parsed.assignment.validUntilUtc);
    const now = new Date();
    if (
      !Number.isFinite(validFrom.getTime()) ||
      !Number.isFinite(validUntil.getTime()) ||
      now > validFrom ||
      validFrom >= validUntil
    ) {
      throw new Error("任务有效期必须从当前时间之后开始，且结束时间晚于开始时间");
    }
    if (this.#catalog.findAssignment(parsed.assignment.assignmentId)) {
      throw new Error(`任务 ${parsed.assignment.assignmentId} 已存在`);
    }

    const usbRoot = assertRealDirectory(parsed.usbRoot, "U 盘根目录");
    const finalDirectory = join(usbRoot, COLLECTOR_DIRECTORY_NAME);
    if (existsSync(finalDirectory)) {
      throw new Error(
        `U 盘中已经存在 ${COLLECTOR_DIRECTORY_NAME} 文件夹；为避免覆盖，请更换空白任务目录或先完成回收归档`,
      );
    }
    const bundleId = randomUUID();
    const stagingDirectory = join(
      usbRoot,
      `.${COLLECTOR_DIRECTORY_NAME}.${bundleId}.partial`,
    );
    if (existsSync(stagingDirectory)) {
      throw new Error("U 盘中存在同名未完成配置目录");
    }
    const release = copyReleasePayload(
      this.#collectorReleaseDirectory,
      stagingDirectory,
    );
    const createdAtUtc = now.toISOString();
    const receipt = provisioningReceiptSchema.parse(
      await runJsonRpc<unknown>(this.#provisionerExecutable, {
        method: "provisionUsb",
        stateDir: this.#catalog.provisioningStateDir,
        collectorRoot: stagingDirectory,
        bundleId,
        operator: {
          schemaVersion: "wafc-operator-template/1",
          operatorId: parsed.operator.operatorId,
          displayName: parsed.operator.displayName,
          organization: parsed.operator.organization,
          keyId: parsed.operator.keyId,
        },
        assignments: [
          {
            schemaVersion: "wafc-assignment-template/1",
            assignmentId: parsed.assignment.assignmentId,
            authorizationReference: parsed.assignment.authorizationReference,
            sourceOrganization: parsed.assignment.sourceOrganization,
            issuedAtUtc: createdAtUtc,
            validFromUtc: parsed.assignment.validFromUtc,
            validUntilUtc: parsed.assignment.validUntilUtc,
            acquisitionMode: parsed.assignment.acquisitionMode,
            mediaPolicy: parsed.assignment.mediaPolicy,
            targetDescription: parsed.assignment.targetDescription,
          },
        ],
        workstationPassphrase: parsed.workstationPassphrase,
        operatorPassphrase: parsed.operatorPassphrase,
        createdAtUtc,
      }),
    );
    if (existsSync(finalDirectory)) {
      throw new Error("配置完成前目标 Field Collector 文件夹被其他程序创建");
    }
    renameSync(stagingDirectory, finalDirectory);

    const operatorRegistryPath = join(
      this.#catalog.provisioningStateDir,
      "operators",
      `${parsed.operator.operatorId}--${parsed.operator.keyId}.json`,
    );
    const registry = operatorRegistrySchema.parse(
      readJsonLimited(operatorRegistryPath),
    );
    if (
      registry.fingerprintSha256 !== receipt.operatorKeyFingerprintSha256 ||
      registry.operatorId !== parsed.operator.operatorId ||
      registry.keyId !== parsed.operator.keyId
    ) {
      throw new Error("Provisioner 收据与勘察员公钥登记不一致");
    }
    this.#catalog.registerAssignment({
      assignmentId: parsed.assignment.assignmentId,
      caseId: parsed.caseId,
      operatorId: parsed.operator.operatorId,
      operatorKeyId: parsed.operator.keyId,
      operatorFingerprint: receipt.operatorKeyFingerprintSha256,
      bundleId: receipt.bundleId,
      authorizationReference: parsed.assignment.authorizationReference,
      validFromUtc: parsed.assignment.validFromUtc,
      validUntilUtc: parsed.assignment.validUntilUtc,
      operatorDisplayName: parsed.operator.displayName,
      operatorOrganization: parsed.operator.organization,
      operatorPublicKeySpkiBase64: registry.publicKeySpkiBase64,
      receiptJson: JSON.stringify(receipt),
      registeredAtUtc: createdAtUtc,
    });
    return {
      ...receipt,
      collectorDirectory: finalDirectory,
      releasePublishable: release.manifest.source.publishable,
    };
  }

  async #inspectPortableBundle(collectorRoot: string) {
    return portableBundleInspectionSchema.parse(
      await runJsonRpc<unknown>(this.#provisionerExecutable, {
        method: "inspectPortableBundle",
        collectorRoot,
      }),
    );
  }

  async #inspectUsbSoftware(input: InspectUsbSoftwareInput) {
    const usbRoot = assertRealDirectory(input.usbRoot, "U 盘根目录");
    recoverInterruptedSoftwareUpdate(usbRoot);
    cleanupCommittedSoftwareBackups(usbRoot);
    const collectorRoot = assertRealDirectory(
      join(usbRoot, COLLECTOR_DIRECTORY_NAME),
      "已部署的 Field Collector 目录",
    );
    const portable = await this.#inspectPortableBundle(collectorRoot);
    const workstation = this.getWorkstationProfile();
    if (!workstation) throw new Error("Workstation 配置签名身份尚未初始化");
    if (
      portable.workstationKeyFingerprintSha256 !== workstation.fingerprintSha256
    ) {
      throw new Error(
        "该取证 U 盘不是由当前 Workstation 信任身份签发，已拒绝更新软件",
      );
    }
    const currentRelease = validateReleasePayload(
      collectorRoot,
      "U 盘已部署软件",
    );
    validateDeployedSoftwareLayout(collectorRoot, currentRelease);
    const availableRelease = validateReleasePayload(
      this.#collectorReleaseDirectory,
      "Workstation 内置 Field Collector",
    );
    const inspection = usbSoftwareInspectionSchema.parse({
      schemaVersion: "wafc-usb-software-inspection/1",
      collectorDirectory: collectorRoot,
      bundleId: portable.bundleId,
      operatorId: portable.operatorId,
      operatorDisplayName: portable.operatorDisplayName,
      assignmentIds: portable.assignmentIds,
      currentReleaseVersion: currentRelease.manifest.releaseVersion,
      availableReleaseVersion: availableRelease.manifest.releaseVersion,
      currentReleasePublishable: currentRelease.manifest.source.publishable,
      availableReleasePublishable: availableRelease.manifest.source.publishable,
      updateNeeded:
        currentRelease.manifestSha256 !== availableRelease.manifestSha256,
    });
    return {
      usbRoot,
      collectorRoot,
      portable,
      currentRelease,
      availableRelease,
      inspection,
    };
  }
}
