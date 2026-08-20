import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import {
  assignTaskInputSchema,
  caseManifestSchema,
  chatQuerySchema,
  createCaseInputSchema,
  messageQuerySchema,
  receiveInputSchema,
  uuidSchema,
  type AssignTaskInput,
  type CaseSummary,
  type ChatQuery,
  type ChatSummary,
  type CreateCaseInput,
  type CursorPage,
  type EvidenceSource,
  type MessageQuery,
  type MessageView,
  type PortableTask,
  type ReceiveInput,
  type ReceiveResult,
  type SettingsInfo,
  type TaskSummary,
} from "@wafc/domain";
import { CaseRepository } from "@wafc/evidence-repository/node";

import { CaseCatalog } from "./catalog.js";
import { WorkstationError } from "./errors.js";
import { ResultImporter } from "./importer.js";
import {
  assertPathInside,
  initializeWorkstationPaths,
  isPathInside,
  sanitizeCaseDirectoryName,
  toPortableRelativePath,
  type WorkstationPaths,
} from "./paths.js";
import { provisionPortableTask } from "./provisioning.js";
import {
  assertSafeDirectory,
  assertSafeRegularFile,
  safeRemoveCreatedDirectory,
} from "./safe-files.js";

export type WorkstationServiceOptions = {
  dataRoot: string;
  collectorPayloadRoot: string;
};

export type ResolvedAsset = {
  path: string;
  mimeType: string | null;
  fileName: string | null;
};

export class WorkstationService {
  readonly paths: WorkstationPaths;
  readonly #catalog: CaseCatalog;
  readonly #collectorPayloadRoot: string;

  constructor(options: WorkstationServiceOptions) {
    this.paths = initializeWorkstationPaths(options.dataRoot);
    this.#catalog = new CaseCatalog(this.paths.catalogPath);
    this.#collectorPayloadRoot = resolve(options.collectorPayloadRoot);
  }

  close(): void {
    this.#catalog.close();
  }

  listCases(): CaseSummary[] {
    return this.#catalog.listCases();
  }

  getCase(caseId: string): CaseSummary {
    const parsedCaseId = uuidSchema.parse(caseId);
    const summary = this.#catalog.getCase(parsedCaseId);
    if (summary === null) {
      throw new WorkstationError("CASE_NOT_FOUND", "没有找到该案件。");
    }
    this.#validateCaseDirectory(summary);
    return summary;
  }

  async createCase(input: CreateCaseInput): Promise<CaseSummary> {
    const parsed = createCaseInputSchema.parse(input);
    const parent = resolve(parsed.parentDirectory);
    assertSafeDirectory(parent, "案件保存位置");
    const caseId = randomUUID();
    const safeName = sanitizeCaseDirectoryName(parsed.name);
    const shortId = caseId.slice(0, 8);
    const finalRoot = join(parent, `${safeName}-${shortId}`);
    const stagingRoot = join(parent, `.${safeName}-${shortId}.partial`);
    if (existsSync(finalRoot) || existsSync(stagingRoot)) {
      throw new WorkstationError(
        "CASE_DIRECTORY_CONFLICT",
        `案件目录已存在，请更换保存位置后重试：${finalRoot}`,
      );
    }
    const createdAtUtc = new Date().toISOString();
    const manifest = {
      schemaVersion: "wafc-analysis-case/1" as const,
      caseId,
      name: parsed.name,
      createdAtUtc,
    };
    try {
      mkdirSync(join(stagingRoot, "tasks"), { recursive: true });
      mkdirSync(join(stagingRoot, "sources"), { recursive: true });
      writeFileSync(join(stagingRoot, "case.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      const repository = new CaseRepository(join(stagingRoot, "case.sqlite"));
      try {
        repository.initializeManifest(manifest);
      } finally {
        repository.close();
      }
      renameSync(stagingRoot, finalRoot);
      const summary: CaseSummary = {
        caseId,
        name: parsed.name,
        path: finalRoot,
        createdAtUtc,
        updatedAtUtc: createdAtUtc,
        lastOpenedAtUtc: createdAtUtc,
        sourceCount: 0,
        taskCount: 0,
        chatCount: 0,
        messageCount: 0,
      };
      try {
        this.#catalog.insertCase(summary);
      } catch (error) {
        safeRemoveCreatedDirectory(parent, finalRoot);
        throw error;
      }
      return summary;
    } catch (error) {
      if (existsSync(stagingRoot)) safeRemoveCreatedDirectory(parent, stagingRoot);
      throw error;
    }
  }

  openCase(caseId: string): CaseSummary {
    const summary = this.getCase(caseId);
    const openedAtUtc = new Date().toISOString();
    this.#catalog.markOpened(summary.caseId, openedAtUtc);
    const updated = this.#catalog.getCase(summary.caseId);
    if (updated === null) throw new Error("case disappeared after opening");
    return updated;
  }

  async assignTask(input: AssignTaskInput): Promise<TaskSummary> {
    const parsed = assignTaskInputSchema.parse(input);
    const caseSummary = this.getCase(parsed.caseId);
    const taskId = randomUUID();
    const createdAtUtc = new Date().toISOString();
    const contract: PortableTask = {
      schemaVersion: "wafc-portable-task/1",
      taskId,
      caseId: caseSummary.caseId,
      caseName: caseSummary.name,
      taskName: parsed.taskName,
      createdAtUtc,
      resultDirectory: "results",
    };
    const provisioned = await provisionPortableTask(
      parsed.usbRoot,
      this.#collectorPayloadRoot,
      contract,
    );
    const taskDirectory = join(caseSummary.path, "tasks", taskId);
    const task: TaskSummary = {
      taskId,
      caseId: caseSummary.caseId,
      taskName: parsed.taskName,
      usbRoot: resolve(parsed.usbRoot),
      collectorDirectory: provisioned.collectorDirectory,
      createdAtUtc,
      status: "active",
      disabledAtUtc: null,
      receivedCount: 0,
    };
    try {
      mkdirSync(taskDirectory, { recursive: false });
      writeFileSync(join(taskDirectory, "task.json"), `${JSON.stringify(contract, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      this.#withRepository(caseSummary, (repository) => repository.insertTask(task));
    } catch (error) {
      if (existsSync(taskDirectory)) {
        safeRemoveCreatedDirectory(join(caseSummary.path, "tasks"), taskDirectory);
      }
      if (existsSync(provisioned.collectorDirectory)) {
        safeRemoveCreatedDirectory(resolve(parsed.usbRoot), provisioned.collectorDirectory);
      }
      throw error;
    }
    this.#refreshCounts(caseSummary);
    return task;
  }

  listTasks(caseId: string): TaskSummary[] {
    const summary = this.getCase(caseId);
    return this.#withRepository(summary, (repository) => repository.listTasks());
  }

  disableTask(caseId: string, taskId: string): TaskSummary {
    const summary = this.getCase(caseId);
    const parsedTaskId = uuidSchema.parse(taskId);
    const task = this.#withRepository(summary, (repository) =>
      repository.disableTask(parsedTaskId, new Date().toISOString()),
    );
    if (task === null) throw new WorkstationError("TASK_NOT_FOUND", "没有找到该任务。");
    return task;
  }

  async receiveResults(input: ReceiveInput): Promise<ReceiveResult[]> {
    const parsed = receiveInputSchema.parse(input);
    const summary = this.getCase(parsed.caseId);
    const repository = new CaseRepository(join(summary.path, "case.sqlite"));
    try {
      const importer = new ResultImporter(summary.caseId, summary.path, repository);
      const results = await importer.receive(parsed.selectedPath);
      this.#catalog.updateCounts(summary.caseId, repository.getCounts(), new Date().toISOString());
      return results;
    } finally {
      repository.close();
    }
  }

  listSources(caseId: string): EvidenceSource[] {
    const summary = this.getCase(caseId);
    return this.#withRepository(summary, (repository) => repository.listSources());
  }

  listChats(caseId: string, query: ChatQuery): CursorPage<ChatSummary> {
    const summary = this.getCase(caseId);
    const parsed = chatQuerySchema.parse(query);
    return this.#withRepository(summary, (repository) => repository.listChats(parsed));
  }

  listMessages(caseId: string, query: MessageQuery): CursorPage<MessageView> {
    const summary = this.getCase(caseId);
    const parsed = messageQuerySchema.parse(query);
    return this.#withRepository(summary, (repository) => repository.listMessages(parsed));
  }

  resolveAsset(caseId: string, opaqueId: string): ResolvedAsset {
    const summary = this.getCase(caseId);
    const parsedOpaqueId = uuidSchema.parse(opaqueId);
    const location = this.#withRepository(summary, (repository) =>
      repository.getAssetLocation(parsedOpaqueId),
    );
    if (
      location === null ||
      location.status !== "available" ||
      location.attachmentRelativePath === null
    ) {
      throw new WorkstationError("ASSET_NOT_AVAILABLE", "该媒体文件当前不可用。");
    }
    const rawRoot = resolve(summary.path, location.rawRelativePath.replaceAll("/", sep));
    const assetPath = resolve(
      rawRoot,
      location.attachmentRelativePath.replaceAll("/", sep),
    );
    assertPathInside(summary.path, rawRoot, "来源目录");
    assertPathInside(rawRoot, assetPath, "媒体路径");
    if (!existsSync(assetPath)) {
      throw new WorkstationError("ASSET_MISSING", "媒体文件已缺失。");
    }
    assertSafeRegularFile(assetPath, "媒体文件");
    return {
      path: assetPath,
      mimeType: location.mimeType,
      fileName: location.fileName,
    };
  }

  resolveAssetAcrossCases(opaqueId: string): ResolvedAsset {
    const parsedOpaqueId = uuidSchema.parse(opaqueId);
    for (const summary of this.#catalog.listCases()) {
      try {
        const location = this.#withRepository(summary, (repository) =>
          repository.getAssetLocation(parsedOpaqueId),
        );
        if (
          location === null ||
          location.status !== "available" ||
          location.attachmentRelativePath === null
        ) {
          continue;
        }
        const rawRoot = resolve(summary.path, location.rawRelativePath.replaceAll("/", sep));
        const assetPath = resolve(
          rawRoot,
          location.attachmentRelativePath.replaceAll("/", sep),
        );
        assertPathInside(summary.path, rawRoot, "来源目录");
        assertPathInside(rawRoot, assetPath, "媒体路径");
        if (!existsSync(assetPath)) continue;
        assertSafeRegularFile(assetPath, "媒体文件");
        return {
          path: assetPath,
          mimeType: location.mimeType,
          fileName: location.fileName,
        };
      } catch (error) {
        if (error instanceof WorkstationError && error.code.startsWith("CASE_")) continue;
        throw error;
      }
    }
    throw new WorkstationError("ASSET_NOT_AVAILABLE", "该媒体文件当前不可用。");
  }

  getSettingsInfo(): SettingsInfo {
    return {
      dataDirectory: this.paths.dataRoot,
      defaultCasesDirectory: this.paths.defaultCasesDirectory,
      catalogPath: this.paths.catalogPath,
    };
  }

  getCaseDirectory(caseId: string): string {
    return this.getCase(caseId).path;
  }

  getTaskDirectory(caseId: string, taskId: string): string {
    const summary = this.getCase(caseId);
    const parsedTaskId = uuidSchema.parse(taskId);
    const taskDirectory = join(summary.path, "tasks", parsedTaskId);
    if (!existsSync(taskDirectory)) {
      throw new WorkstationError("TASK_NOT_FOUND", "任务目录不存在。");
    }
    assertPathInside(summary.path, taskDirectory, "任务目录");
    return taskDirectory;
  }

  #withRepository<T>(summary: CaseSummary, action: (repository: CaseRepository) => T): T {
    const repository = new CaseRepository(join(summary.path, "case.sqlite"));
    try {
      const manifest = repository.getManifest();
      if (manifest.caseId !== summary.caseId) {
        throw new WorkstationError("CASE_DATABASE_MISMATCH", "案件数据库与案件目录不匹配。");
      }
      return action(repository);
    } finally {
      repository.close();
    }
  }

  #refreshCounts(summary: CaseSummary): void {
    const counts = this.#withRepository(summary, (repository) => repository.getCounts());
    this.#catalog.updateCounts(summary.caseId, counts, new Date().toISOString());
  }

  #validateCaseDirectory(summary: CaseSummary): void {
    assertSafeDirectory(summary.path, "案件目录");
    const manifestPath = join(summary.path, "case.json");
    assertSafeRegularFile(manifestPath, "case.json");
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      throw new WorkstationError("CASE_MANIFEST_INVALID", "case.json 不是有效 JSON。", error);
    }
    const manifest = caseManifestSchema.parse(value);
    if (manifest.caseId !== summary.caseId) {
      throw new WorkstationError("CASE_MANIFEST_MISMATCH", "案件目录与 catalog 记录不匹配。");
    }
    const databasePath = join(summary.path, "case.sqlite");
    assertSafeRegularFile(databasePath, "case.sqlite");
  }
}
