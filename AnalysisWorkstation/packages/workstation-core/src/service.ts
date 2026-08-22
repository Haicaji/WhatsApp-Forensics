import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  assignTaskInputSchema,
  caseManifestSchema,
  chatQuerySchema,
  createCaseInputSchema,
  messageQuerySchema,
  offlinePreviewExportInputSchema,
  receiveInputSchema,
  uuidSchema,
  type AssignTaskInput,
  type AttachmentView,
  type CaseSummary,
  type ChatQuery,
  type ChatSummary,
  type CreateCaseInput,
  type CursorPage,
  type EvidenceSource,
  type MessageQuery,
  type MessageView,
  type OfflinePreviewExportInput,
  type OfflinePreviewExportResult,
  type PortableTask,
  type ReceiveInput,
  type ReceiveResult,
  type SettingsInfo,
  type SourceFeatureAvailability,
  type SourceWorkspaceView,
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
  createOfflinePreviewSuggestedFileName,
  writeOfflinePreview,
  type OfflinePreviewAssetSource,
  type OfflinePreviewConversation,
} from "./offline-preview.js";
import {
  assertSafeDirectory,
  assertSafeRegularFile,
  safeRemoveCreatedDirectory,
} from "./safe-files.js";
import { normalizeEvidenceTimestamp } from "./timestamps.js";

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
  readonly #chatPhoneBackfilledSources = new Set<string>();

  constructor(options: WorkstationServiceOptions) {
    this.paths = initializeWorkstationPaths(options.dataRoot);
    this.#catalog = new CaseCatalog(this.paths.catalogPath);
    this.#collectorPayloadRoot = resolve(options.collectorPayloadRoot);
    this.#relinkPortableCases();
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

  getSourceWorkspace(caseId: string, sourceId: string): SourceWorkspaceView {
    const summary = this.getCase(caseId);
    const parsedSourceId = uuidSchema.parse(sourceId);
    return this.#withRepository(summary, (repository) => {
      const source = repository.getSource(parsedSourceId);
      const rawRelativePath = repository.getSourceRawRelativePath(parsedSourceId);
      if (source === null || rawRelativePath === null) {
        throw new WorkstationError("SOURCE_NOT_FOUND", "没有找到该检材来源。");
      }
      const rawRoot = resolve(summary.path, rawRelativePath.replaceAll("/", sep));
      assertPathInside(summary.path, rawRoot, "检材来源目录");
      assertSafeDirectory(rawRoot, "检材来源目录");

      const chatTitles = new Map<string, string>();
      let chatCursor: string | null = null;
      do {
        const page = repository.listChats({
          sourceId: parsedSourceId,
          search: "",
          cursor: chatCursor,
          limit: 200,
        });
        for (const chat of page.items) chatTitles.set(chat.nativeId, chat.title);
        chatCursor = page.nextCursor;
      } while (chatCursor !== null && chatTitles.size < 2_000);

      return readSourceWorkspace(rawRoot, parsedSourceId, chatTitles);
    });
  }

  listChats(caseId: string, query: ChatQuery): CursorPage<ChatSummary> {
    const summary = this.getCase(caseId);
    const parsed = chatQuerySchema.parse(query);
    return this.#withRepository(summary, (repository) => {
      const rawRelativePath = repository.getSourceRawRelativePath(parsed.sourceId);
      if (rawRelativePath === null) return repository.listChats(parsed);
      const rawRoot = resolve(summary.path, rawRelativePath.replaceAll("/", sep));
      if (!isPathInside(summary.path, rawRoot) || !existsSync(rawRoot)) {
        return repository.listChats(parsed);
      }
      try {
        assertSafeDirectory(rawRoot, "检材来源目录");
      } catch {
        return repository.listChats(parsed);
      }

      const phoneBackfillKey = `${summary.caseId}:${parsed.sourceId}`;
      if (!this.#chatPhoneBackfilledSources.has(phoneBackfillKey)) {
        repository.backfillChatPhoneIdentities(
          parsed.sourceId,
          readRawChatPhoneIdentities(rawRoot),
        );
        this.#chatPhoneBackfilledSources.add(phoneBackfillKey);
      }

      const communities = asRecordArray(
        readOptionalJson(rawRoot, "global", "communities.json").value,
      );
      const relations = asRecordArray(
        readOptionalJson(rawRoot, "global", "community-relations.json").value,
      );
      const roots = communityRelationships(communities, relations, new Map()).communityIds;
      const visibleChats: ChatSummary[] = [];
      const seenCursors = new Set<string>();
      let cursor = parsed.cursor;
      do {
        const page = repository.listChats({
          ...parsed,
          cursor,
          limit: parsed.limit - visibleChats.length,
        });
        visibleChats.push(...page.items.filter((chat) => !roots.has(chat.nativeId)));
        cursor = page.nextCursor;
        if (cursor !== null) {
          if (seenCursors.has(cursor)) break;
          seenCursors.add(cursor);
        }
      } while (visibleChats.length < parsed.limit && cursor !== null);

      const chatTitles = new Map(visibleChats.map((chat) => [chat.nativeId, chat.title]));
      const relationships = communityRelationships(
        communities,
        relations,
        chatTitles,
      );
      const avatarUrls = avatarUrlsByNativeId(rawRoot, parsed.sourceId);
      return {
        nextCursor: cursor,
        items: visibleChats.map((chat) => {
          const community = relationships.byChatId.get(chat.nativeId) ?? null;
          const communityAvatarUrl = community === null
            ? null
            : avatarUrls.get(community.id) ?? null;
          const isCommunityMainChat = community?.role === "announcement";
          return {
            ...chat,
            title: isCommunityMainChat ? community.title : chat.title,
            avatarUrl: isCommunityMainChat
              ? communityAvatarUrl
              : avatarUrls.get(chat.nativeId) ?? null,
            community: community === null
              ? null
              : {
                  ...community,
                  avatarUrl: communityAvatarUrl,
                },
          };
        }),
      };
    });
  }

  listMessages(caseId: string, query: MessageQuery): CursorPage<MessageView> {
    const summary = this.getCase(caseId);
    const parsed = messageQuerySchema.parse(query);
    return this.#withRepository(summary, (repository) => repository.listMessages(parsed));
  }

  getOfflinePreviewSuggestedFileName(caseId: string, sourceId: string): string {
    const source = this.#sourceForExport(caseId, sourceId);
    return createOfflinePreviewSuggestedFileName(source.specimenName);
  }

  async exportOfflinePreview(
    input: OfflinePreviewExportInput,
  ): Promise<OfflinePreviewExportResult> {
    const parsed = offlinePreviewExportInputSchema.parse(input);
    const summary = this.getCase(parsed.caseId);
    const source = this.#sourceForExport(summary.caseId, parsed.sourceId);
    const workspace = this.getSourceWorkspace(summary.caseId, source.sourceId);
    const chats = this.#allChatsForExport(summary.caseId, source.sourceId);
    const conversations: OfflinePreviewConversation[] = [];
    for (const chat of chats) {
      conversations.push({
        chat,
        messages: this.#allMessagesForExport(summary.caseId, source.sourceId, chat.nativeId),
      });
    }

    const assetIds = new Set<string>();
    for (const conversation of conversations) {
      addMediaUrlAssetId(assetIds, conversation.chat.avatarUrl);
      addMediaUrlAssetId(assetIds, conversation.chat.community?.avatarUrl ?? null);
      for (const message of conversation.messages) {
        for (const attachment of message.attachments) {
          if (attachment.status === "available") assetIds.add(attachment.opaqueId);
        }
      }
    }
    for (const channel of workspace.channels) {
      addMediaUrlAssetId(assetIds, channel.avatarUrl);
      for (const message of channel.messages) {
        for (const attachment of message.attachments) {
          if (attachment.status === "available") assetIds.add(attachment.opaqueId);
        }
      }
    }

    const assets: OfflinePreviewAssetSource[] = [];
    for (const assetId of assetIds) {
      try {
        const resolvedAsset = this.resolveAsset(summary.caseId, assetId);
        assets.push({ assetId, ...resolvedAsset });
      } catch (error) {
        if (
          error instanceof WorkstationError &&
          (error.code === "ASSET_MISSING" || error.code === "ASSET_NOT_AVAILABLE")
        ) {
          continue;
        }
        throw error;
      }
    }

    return writeOfflinePreview({
      targetPath: parsed.targetPath,
      dataset: {
        caseName: summary.name,
        generatedAtUtc: new Date().toISOString(),
        displayTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        source,
        workspace,
        conversations,
      },
      assets,
    });
  }

  resolveAsset(caseId: string, opaqueId: string): ResolvedAsset {
    const summary = this.getCase(caseId);
    const parsedOpaqueId = uuidSchema.parse(opaqueId);
    const location = this.#withRepository(summary, (repository) =>
      repository.getAssetLocation(parsedOpaqueId),
    );
    if (
      location !== null &&
      location.status === "available" &&
      location.attachmentRelativePath !== null
    ) {
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
    const channelAsset = this.#resolveChannelAsset(summary, parsedOpaqueId);
    if (channelAsset !== null) return channelAsset;
    const avatarAsset = this.#resolveAvatarAsset(summary, parsedOpaqueId);
    if (avatarAsset !== null) return avatarAsset;
    throw new WorkstationError("ASSET_NOT_AVAILABLE", "该媒体文件当前不可用。");
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
          const channelAsset = this.#resolveChannelAsset(summary, parsedOpaqueId);
          if (channelAsset !== null) return channelAsset;
          const avatarAsset = this.#resolveAvatarAsset(summary, parsedOpaqueId);
          if (avatarAsset !== null) return avatarAsset;
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

  #sourceForExport(caseId: string, sourceId: string): EvidenceSource {
    const parsedSourceId = uuidSchema.parse(sourceId);
    const source = this.listSources(caseId).find((item) => item.sourceId === parsedSourceId);
    if (source === undefined) {
      throw new WorkstationError("SOURCE_NOT_FOUND", "没有找到要导出的 WhatsApp 账号。");
    }
    return source;
  }

  #allChatsForExport(caseId: string, sourceId: string): ChatSummary[] {
    const chats: ChatSummary[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = this.listChats(caseId, { sourceId, search: "", cursor, limit: 200 });
      chats.push(...page.items);
      cursor = page.nextCursor;
      if (cursor !== null) {
        if (seenCursors.has(cursor)) {
          throw new WorkstationError("OFFLINE_PREVIEW_PAGINATION_INVALID", "导出对话列表时游标重复。");
        }
        seenCursors.add(cursor);
      }
    } while (cursor !== null);
    return chats;
  }

  #allMessagesForExport(caseId: string, sourceId: string, chatNativeId: string): MessageView[] {
    const pages: MessageView[][] = [];
    const seenCursors = new Set<string>();
    let beforeCursor: string | null = null;
    do {
      const page = this.listMessages(caseId, {
        sourceId,
        chatNativeId,
        beforeCursor,
        limit: 200,
      });
      pages.unshift(page.items);
      beforeCursor = page.nextCursor;
      if (beforeCursor !== null) {
        if (seenCursors.has(beforeCursor)) {
          throw new WorkstationError("OFFLINE_PREVIEW_PAGINATION_INVALID", "导出消息时游标重复。");
        }
        seenCursors.add(beforeCursor);
      }
    } while (beforeCursor !== null);
    return pages.flat();
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

  #resolveChannelAsset(summary: CaseSummary, opaqueId: string): ResolvedAsset | null {
    return this.#withRepository(summary, (repository) => {
      for (const source of repository.listSources()) {
        const rawRelativePath = repository.getSourceRawRelativePath(source.sourceId);
        if (rawRelativePath === null) continue;
        const rawRoot = resolve(summary.path, rawRelativePath.replaceAll("/", sep));
        if (!isPathInside(summary.path, rawRoot) || !existsSync(rawRoot)) continue;
        try {
          assertSafeDirectory(rawRoot, "检材来源目录");
        } catch {
          continue;
        }
        const asset = resolveChannelAssetFromRawRoot(rawRoot, source.sourceId, opaqueId);
        if (asset !== null) return asset;
      }
      return null;
    });
  }

  #resolveAvatarAsset(summary: CaseSummary, opaqueId: string): ResolvedAsset | null {
    return this.#withRepository(summary, (repository) => {
      for (const source of repository.listSources()) {
        const rawRelativePath = repository.getSourceRawRelativePath(source.sourceId);
        if (rawRelativePath === null) continue;
        const rawRoot = resolve(summary.path, rawRelativePath.replaceAll("/", sep));
        if (!isPathInside(summary.path, rawRoot) || !existsSync(rawRoot)) continue;
        try {
          assertSafeDirectory(rawRoot, "检材来源目录");
        } catch {
          continue;
        }
        const asset = resolveAvatarAssetFromRawRoot(rawRoot, source.sourceId, opaqueId);
        if (asset !== null) return asset;
      }
      return null;
    });
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

  #relinkPortableCases(): void {
    const cases = this.#catalog.listCases();
    const needsRelink = cases.filter((summary) =>
      !existsSync(summary.path) || isFormerPortableCasePath(
        summary.path,
        this.paths.defaultCasesDirectory,
      ),
    );
    if (needsRelink.length === 0) return;

    const candidatesByCaseId = discoverPortableCases(this.paths.defaultCasesDirectory);
    for (const summary of needsRelink) {
      const candidates = candidatesByCaseId.get(summary.caseId) ?? [];
      if (candidates.length !== 1) continue;
      const candidate = candidates[0];
      if (candidate === undefined || resolve(candidate) === resolve(summary.path)) continue;
      this.#catalog.updatePath(summary.caseId, candidate);
    }
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

function addMediaUrlAssetId(assetIds: Set<string>, url: string | null): void {
  if (url === null) return;
  const match = /^wafc-media:\/\/asset\/([0-9a-f-]+)$/iu.exec(url);
  if (match?.[1] !== undefined) assetIds.add(match[1]);
}

function isFormerPortableCasePath(path: string, currentCasesDirectory: string): boolean {
  const resolvedPath = resolve(path);
  if (isPathInside(currentCasesDirectory, resolvedPath)) return false;
  const casesDirectory = dirname(resolvedPath);
  const dataDirectory = dirname(casesDirectory);
  return basename(casesDirectory).toLocaleLowerCase("en-US") === "cases"
    && basename(dataDirectory).toLocaleLowerCase("en-US") === "analysisworkstationdata";
}

function discoverPortableCases(casesDirectory: string): Map<string, string[]> {
  const candidates = new Map<string, string[]>();
  for (const entry of readdirSync(casesDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const candidate = resolve(casesDirectory, entry.name);
    const caseId = readPortableCaseId(candidate);
    if (caseId === null) continue;
    const current = candidates.get(caseId) ?? [];
    current.push(candidate);
    candidates.set(caseId, current);
  }
  return candidates;
}

function readPortableCaseId(caseDirectory: string): string | null {
  try {
    assertPathInside(dirname(caseDirectory), caseDirectory, "案件目录");
    assertSafeDirectory(caseDirectory, "案件目录");
    const manifestPath = join(caseDirectory, "case.json");
    const databasePath = join(caseDirectory, "case.sqlite");
    assertSafeRegularFile(manifestPath, "case.json");
    assertSafeRegularFile(databasePath, "case.sqlite");
    const manifest = caseManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const rows = database.prepare("SELECT key, value FROM case_meta").all() as Array<{
        key: unknown;
        value: unknown;
      }>;
      const values = Object.fromEntries(rows.map((row) => [String(row.key), String(row.value)]));
      const databaseManifest = caseManifestSchema.parse({
        schemaVersion: values.schemaVersion,
        caseId: values.caseId,
        name: values.name,
        createdAtUtc: values.createdAtUtc,
      });
      return databaseManifest.caseId === manifest.caseId ? manifest.caseId : null;
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}

const SOURCE_FEATURE_RECORD_LIMIT = 500;
const SOURCE_FEATURE_FILE_LIMIT_BYTES = 64 * 1024 * 1024;

type JsonFileResult = {
  present: boolean;
  value: unknown;
  error: string | null;
  tooLarge: boolean;
};

function readSourceWorkspace(
  rawRoot: string,
  sourceId: string,
  chatTitles: ReadonlyMap<string, string>,
): SourceWorkspaceView {
  const accountFile = readOptionalJson(rawRoot, "account.json");
  const capabilitiesFile = readOptionalJson(rawRoot, "capabilities.json");
  const callsFile = readOptionalJson(rawRoot, "global", "calls.json");
  const statusesFile = readOptionalJson(rawRoot, "global", "statuses.json");
  const channelsFile = readOptionalJson(rawRoot, "global", "channels.json");
  const channelEventsFile = readOptionalJson(rawRoot, "global", "channel-events.json");
  const channelMediaFile = readOptionalJson(
    rawRoot,
    "global",
    "channel-media",
    "index.json",
  );
  const communitiesFile = readOptionalJson(rawRoot, "global", "communities.json");
  const communityRelationsFile = readOptionalJson(
    rawRoot,
    "global",
    "community-relations.json",
  );

  const accountRecord = asRecord(accountFile.value);
  const callsInput = asRecordArray(callsFile.value);
  const statusesInput = asRecordArray(statusesFile.value);
  const channelsInput = asRecordArray(channelsFile.value);
  const channelEvents = asRecordArray(channelEventsFile.value);
  const avatarUrls = avatarUrlsByNativeId(rawRoot, sourceId);
  const channelMedia = channelAttachmentsByMessage(
    rawRoot,
    sourceId,
    asRecordArray(channelMediaFile.value),
  );
  const communitiesInput = asRecordArray(communitiesFile.value);
  const communityRelations = asRecordArray(communityRelationsFile.value);

  const calls = callsInput.slice(0, SOURCE_FEATURE_RECORD_LIMIT).map((record, index) => {
    const peerId = firstString(record.peerId, record.chatId, record.remote);
    const rawDirection = firstString(record.direction);
    return {
      id: firstString(record.id) ?? `call-${index}`,
      peerId,
      title: titleForNativeId(peerId, chatTitles, "未知联系人"),
      timestampUtc: normalizeEvidenceTimestamp(firstString(record.timestamp, record.timestampUtc)),
      durationSeconds: nonnegativeNumber(record.durationSeconds, record.duration),
      direction: (rawDirection === "incoming" || rawDirection === "outgoing"
        ? rawDirection
        : "unknown") as "incoming" | "outgoing" | "unknown",
      isVideo: booleanValue(record.isVideo, record.video),
      isGroup: booleanValue(record.isGroup, record.groupCall),
      state: firstString(record.state, record.reason),
    };
  }).sort((left, right) => compareTimestampDescending(left.timestampUtc, right.timestampUtc));

  const statuses = statusesInput.slice(0, SOURCE_FEATURE_RECORD_LIMIT).map((record, index) => {
    const items = asRecordArray(record.items);
    const lastItem = items.at(-1) ?? null;
    const contactId = firstString(record.contactId, record.publisherId, record.senderId, record.id);
    return {
      id: firstString(record.id, record.publisherId) ?? `status-${index}`,
      contactId,
      title: titleForNativeId(contactId, chatTitles, "未知发布者"),
      timestampUtc: normalizeEvidenceTimestamp(firstString(
        record.timestamp,
        record.timestampUtc,
        lastItem?.timestamp,
      )),
      expiresAtUtc: normalizeEvidenceTimestamp(firstString(record.expiresAt, lastItem?.expiresAt)),
      itemCount: items.length > 0
        ? items.length
        : Math.max(0, Math.trunc(nonnegativeNumber(record.totalCount) ?? 0)),
      preview: firstString(lastItem?.text, lastItem?.caption, lastItem?.type),
    };
  }).sort((left, right) => compareTimestampDescending(left.timestampUtc, right.timestampUtc));

  const eventsByChannel = new Map<string, Record<string, unknown>[]>();
  for (const event of channelEvents) {
    const channelId = firstString(event.channelId, event.chatId);
    if (channelId === null) continue;
    const current = eventsByChannel.get(channelId) ?? [];
    current.push(event);
    eventsByChannel.set(channelId, current);
  }
  const channels = channelsInput.slice(0, SOURCE_FEATURE_RECORD_LIMIT).map((record, index) => {
    const id = firstString(record.id) ?? `channel-${index}`;
    const events = eventsByChannel.get(id) ?? [];
    const normalizedMessages = events.map((event, eventIndex) => {
      const messageId = firstString(event.id, event.messageId) ?? `${id}-event-${eventIndex}`;
      const mediaRecord = asRecord(event.media);
      const indexedAttachments = channelMedia.get(channelMediaKey(id, messageId)) ?? [];
      const hasMedia = booleanValue(event.hasMedia)
        || firstString(mediaRecord?.mimeType, mediaRecord?.fileName) !== null;
      const attachments = indexedAttachments.length > 0 || !hasMedia
        ? indexedAttachments
        : [missingChannelAttachment(sourceId, id, messageId, eventIndex, event, mediaRecord)];
      return {
        id: messageId,
        timestampUtc: normalizeEvidenceTimestamp(firstString(event.timestamp, event.timestampUtc)),
        senderId: firstString(event.senderId, event.authorId, event.from),
        type: firstString(event.type, event.kind) ?? (hasMedia ? "media" : "unknown"),
        text: firstString(event.text, event.body),
        caption: firstString(event.caption),
        isForwarded: booleanValue(event.isForwarded, event.forwardingScore),
        isStarred: booleanValue(event.isStarred, event.star),
        isRevoked: booleanValue(event.isRevoked, event.revoked),
        attachments,
      };
    }).sort((left, right) => compareTimestampAscending(left.timestampUtc, right.timestampUtc));
    const messagesTruncated = normalizedMessages.length > SOURCE_FEATURE_RECORD_LIMIT;
    const messages = messagesTruncated
      ? normalizedMessages.slice(-SOURCE_FEATURE_RECORD_LIMIT)
      : normalizedMessages;
    const lastEvent = normalizedMessages.at(-1) ?? null;
    return {
      id,
      title: firstString(record.title, record.name) ?? titleForNativeId(id, chatTitles, "未命名频道"),
      avatarUrl: avatarUrls.get(id) ?? null,
      description: firstString(record.description, record.about),
      subscribersCount: nonnegativeNumber(record.subscribersCount, record.followersCount),
      unreadCount: Math.max(0, Math.trunc(nonnegativeNumber(record.unreadCount) ?? 0)),
      eventCount: normalizedMessages.length,
      lastEventAtUtc: lastEvent?.timestampUtc ?? null,
      lastEventPreview: firstString(lastEvent?.text, lastEvent?.caption, lastEvent?.type),
      historyComplete: nullableBoolean(record.historyComplete),
      messages,
      messagesTruncated,
    };
  }).sort((left, right) => compareTimestampDescending(left.lastEventAtUtc, right.lastEventAtUtc));

  const relationships = communityRelationships(
    communitiesInput,
    communityRelations,
    chatTitles,
  );
  const communities = communitiesInput.filter((record) => {
    const id = firstString(record.id);
    if (id === null) return false;
    const raw = asRecord(record.raw);
    const source = firstString(record.source);
    return relationships.communityIds.has(id)
      || booleanValue(raw?.isParentGroup)
      || source?.startsWith("WAWebCommunity") === true;
  }).slice(0, SOURCE_FEATURE_RECORD_LIMIT).map((record, index) => {
    const id = firstString(record.id) ?? `community-${index}`;
    return {
      id,
      title: firstString(record.title, record.name) ?? titleForNativeId(id, chatTitles, "未命名社群"),
      description: firstString(record.description, record.about),
      createdAtUtc: normalizeEvidenceTimestamp(firstString(record.createdAt, record.createdAtUtc)),
      childGroups: relationships.childrenByCommunity.get(id) ?? [],
    };
  });

  return {
    sourceId,
    visibleChatCount: Array.from(chatTitles.keys()).filter(
      (chatId) => !relationships.communityIds.has(chatId),
    ).length,
    account: {
      nativeId: firstString(accountRecord?.id, accountRecord?.phoneId, accountRecord?.lidId),
      displayName: firstString(
        accountRecord?.displayName,
        accountRecord?.name,
        accountRecord?.pushName,
      ),
      about: firstString(accountRecord?.about),
      formattedPhoneNumber: firstString(
        accountRecord?.formattedPhoneNumber,
        accountRecord?.phoneNumber,
      ),
    },
    calls,
    statuses,
    channels,
    communities,
    availability: {
      calls: featureAvailability(
        "calls",
        callsFile,
        callsInput.length,
        callsInput.length > SOURCE_FEATURE_RECORD_LIMIT,
        capabilitiesFile.value,
      ),
      statuses: featureAvailability(
        "statuses",
        statusesFile,
        statusesInput.length,
        statusesInput.length > SOURCE_FEATURE_RECORD_LIMIT,
        capabilitiesFile.value,
      ),
      channels: featureAvailability(
        "channels",
        channelsFile,
        channelsInput.length,
        channelsInput.length > SOURCE_FEATURE_RECORD_LIMIT,
        capabilitiesFile.value,
      ),
      communities: featureAvailability(
        "communities",
        communitiesFile,
        communitiesInput.length,
        communitiesInput.length > SOURCE_FEATURE_RECORD_LIMIT,
        capabilitiesFile.value,
      ),
    },
  };
}

type CommunityGroupRole = "announcement" | "group";

type CommunityGroupLink = {
  id: string;
  title: string;
  role: CommunityGroupRole;
};

function communityRelationships(
  communities: readonly Record<string, unknown>[],
  relations: readonly Record<string, unknown>[],
  chatTitles: ReadonlyMap<string, string>,
): {
  byChatId: Map<string, CommunityGroupLink>;
  childrenByCommunity: Map<string, CommunityGroupLink[]>;
  communityIds: Set<string>;
} {
  const communityTitles = new Map<string, string>();
  const communityIds = new Set<string>();
  for (const record of communities) {
    const id = firstString(record.id);
    if (id === null) continue;
    communityTitles.set(
      id,
      firstString(record.title, record.name) ?? titleForNativeId(id, chatTitles, "未命名社群"),
    );
    const raw = asRecord(record.raw);
    const source = firstString(record.source);
    const rootFlags = [
      record.isParentGroup,
      record.isCommunity,
      record.isCommunityParentGroup,
      raw?.isParentGroup,
      raw?.isCommunity,
      raw?.isCommunityParentGroup,
    ];
    if (
      source?.startsWith("WAWebCommunity") === true
      || rootFlags.some((value) => booleanValue(value))
    ) {
      communityIds.add(id);
    }
  }

  const byChatId = new Map<string, CommunityGroupLink>();
  const childrenByCommunity = new Map<string, CommunityGroupLink[]>();
  const remember = (communityId: string, childId: string, role: CommunityGroupRole): void => {
    if (
      communityId === childId
      || !isWhatsAppGroupId(communityId)
      || !isWhatsAppGroupId(childId)
    ) return;
    communityIds.add(communityId);
    const communityTitle = communityTitles.get(communityId)
      ?? titleForNativeId(communityId, chatTitles, "未命名社群");
    const currentLink = byChatId.get(childId);
    if (currentLink === undefined || role === "announcement") {
      byChatId.set(childId, { id: communityId, title: communityTitle, role });
    }

    const children = childrenByCommunity.get(communityId) ?? [];
    const existingIndex = children.findIndex((child) => child.id === childId);
    const child: CommunityGroupLink = {
      id: childId,
      title: titleForNativeId(childId, chatTitles, "未命名群组"),
      role,
    };
    if (existingIndex === -1) children.push(child);
    else if (role === "announcement") children[existingIndex] = child;
    children.sort((left, right) => {
      if (left.role !== right.role) return left.role === "announcement" ? -1 : 1;
      return left.title.localeCompare(right.title, "zh-CN");
    });
    childrenByCommunity.set(communityId, children);
  };

  for (const relation of relations) {
    const kind = firstString(relation.relationKind);
    const fromId = firstString(relation.fromId);
    const toId = firstString(relation.toId);
    if (fromId === null || toId === null) continue;
    if (kind === "community_parent") {
      remember(toId, fromId, "group");
    } else if (kind === "community_child_group") {
      remember(fromId, toId, "group");
    } else if (kind === "community_announcement_group") {
      remember(fromId, toId, "announcement");
    }
  }

  return { byChatId, childrenByCommunity, communityIds };
}

function isWhatsAppGroupId(value: string): boolean {
  return /@g\.us$/iu.test(value);
}

function channelAttachmentsByMessage(
  rawRoot: string,
  sourceId: string,
  records: readonly Record<string, unknown>[],
): Map<string, AttachmentView[]> {
  const attachments = new Map<string, AttachmentView[]>();
  records.forEach((record, index) => {
    const channelId = firstString(record.channelId, record.chatId);
    const messageId = firstString(record.messageId, record.id);
    if (channelId === null || messageId === null) return;
    const relativePath = firstString(record.relativePath);
    const availability = channelMediaAvailability(
      rawRoot,
      relativePath,
      firstString(record.status),
      firstString(record.failureReason, record.reason),
    );
    const mimeType = firstString(record.mimeType, record.mimetype);
    const kind = channelAttachmentKind(mimeType, firstString(record.type, record.role));
    const opaqueId = channelAttachmentOpaqueId(
      sourceId,
      channelId,
      messageId,
      index,
      relativePath,
    );
    const attachment: AttachmentView = {
      opaqueId,
      sourceId,
      messageNativeId: messageId,
      kind,
      status: availability.status,
      mimeType,
      fileName: firstString(record.originalFileName, record.fileName),
      sizeBytes: nullableInteger(record.byteLength, record.size),
      url: availability.status === "available" ? `wafc-media://asset/${opaqueId}` : null,
      failureReason: availability.failureReason,
    };
    const key = channelMediaKey(channelId, messageId);
    const current = attachments.get(key) ?? [];
    current.push(attachment);
    attachments.set(key, current);
  });
  return attachments;
}

function missingChannelAttachment(
  sourceId: string,
  channelId: string,
  messageId: string,
  eventIndex: number,
  event: Record<string, unknown>,
  media: Record<string, unknown> | null,
): AttachmentView {
  const mimeType = firstString(media?.mimeType, media?.mimetype, event.mediaMimeType);
  return {
    opaqueId: channelAttachmentOpaqueId(
      sourceId,
      channelId,
      messageId,
      -1 - eventIndex,
      null,
    ),
    sourceId,
    messageNativeId: messageId,
    kind: channelAttachmentKind(mimeType, firstString(event.type, event.kind)),
    status: "missing",
    mimeType,
    fileName: firstString(media?.fileName, media?.filename, event.mediaFileName),
    sizeBytes: nullableInteger(media?.size, media?.fileSize, event.mediaSize),
    url: null,
    failureReason: "channel_media_index_entry_missing",
  };
}

function resolveChannelAssetFromRawRoot(
  rawRoot: string,
  sourceId: string,
  opaqueId: string,
): ResolvedAsset | null {
  const mediaFile = readOptionalJson(rawRoot, "global", "channel-media", "index.json");
  const records = asRecordArray(mediaFile.value);
  for (const [index, record] of records.entries()) {
    const channelId = firstString(record.channelId, record.chatId);
    const messageId = firstString(record.messageId, record.id);
    const relativePath = firstString(record.relativePath);
    if (channelId === null || messageId === null || relativePath === null) continue;
    if (
      channelAttachmentOpaqueId(sourceId, channelId, messageId, index, relativePath)
      !== opaqueId
    ) continue;
    const availability = channelMediaAvailability(
      rawRoot,
      relativePath,
      firstString(record.status),
      firstString(record.failureReason, record.reason),
    );
    if (availability.status !== "available" || availability.path === null) return null;
    return {
      path: availability.path,
      mimeType: firstString(record.mimeType, record.mimetype),
      fileName: firstString(record.originalFileName, record.fileName),
    };
  }
  return null;
}

function channelMediaAvailability(
  rawRoot: string,
  relativePath: string | null,
  rawStatus: string | null,
  rawFailureReason: string | null,
): {
  status: AttachmentView["status"];
  path: string | null;
  failureReason: string | null;
} {
  if (rawStatus !== "available") {
    return {
      status: rawStatus === "missing" ? "missing" : "failed",
      path: null,
      failureReason: rawFailureReason ?? `channel_media_${rawStatus ?? "unavailable"}`,
    };
  }
  if (relativePath === null) {
    return { status: "missing", path: null, failureReason: "channel_media_path_missing" };
  }
  const target = resolve(rawRoot, relativePath.replaceAll("/", sep));
  if (!isPathInside(rawRoot, target)) {
    return { status: "failed", path: null, failureReason: "channel_media_path_escape" };
  }
  if (!existsSync(target)) {
    return { status: "missing", path: null, failureReason: "channel_media_file_missing" };
  }
  try {
    assertSafeRegularFile(target, "频道媒体文件");
  } catch {
    return { status: "failed", path: null, failureReason: "channel_media_file_unsafe" };
  }
  return { status: "available", path: target, failureReason: rawFailureReason };
}

function channelAttachmentKind(
  mimeType: string | null,
  type: string | null,
): AttachmentView["kind"] {
  const mime = mimeType?.toLocaleLowerCase("en-US") ?? "";
  const normalizedType = type?.toLocaleLowerCase("en-US") ?? "";
  if (mime.startsWith("image/") || normalizedType === "image" || normalizedType === "sticker") {
    return "image";
  }
  if (mime.startsWith("audio/") || normalizedType === "audio" || normalizedType === "ptt") {
    return "audio";
  }
  if (mime.startsWith("video/") || normalizedType === "video") return "video";
  if (normalizedType === "document" || mime === "application/pdf" || mime.startsWith("text/")) {
    return "document";
  }
  return "other";
}

function channelAttachmentOpaqueId(
  sourceId: string,
  channelId: string,
  messageId: string,
  index: number,
  relativePath: string | null,
): string {
  const bytes = createHash("sha256")
    .update([sourceId, channelId, messageId, String(index), relativePath ?? ""].join("\0"))
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type AvatarAssetRecord = {
  nativeId: string;
  opaqueId: string;
  path: string;
  mimeType: string;
  fileName: string;
};

function avatarUrlsByNativeId(rawRoot: string, sourceId: string): Map<string, string> {
  return new Map(readAvatarAssets(rawRoot, sourceId).map((asset) => [
    asset.nativeId,
    `wafc-media://asset/${asset.opaqueId}`,
  ]));
}

function resolveAvatarAssetFromRawRoot(
  rawRoot: string,
  sourceId: string,
  opaqueId: string,
): ResolvedAsset | null {
  const asset = readAvatarAssets(rawRoot, sourceId)
    .find((candidate) => candidate.opaqueId === opaqueId);
  return asset === undefined
    ? null
    : { path: asset.path, mimeType: asset.mimeType, fileName: asset.fileName };
}

function readAvatarAssets(rawRoot: string, sourceId: string): AvatarAssetRecord[] {
  const current = readOptionalJson(rawRoot, "media", "avatars.json");
  const legacy = current.present
    ? null
    : readOptionalJson(rawRoot, "avatars", "index.json");
  const records = asRecordArray(current.present ? current.value : legacy?.value);
  const assets: AvatarAssetRecord[] = [];
  records.forEach((record, index) => {
    const status = firstString(record.status);
    if (status !== "available" && status !== "complete") return;
    const nativeId = firstString(record.contactId, record.id);
    const relativePath = firstString(record.relativePath);
    if (nativeId === null || relativePath === null) return;
    const target = resolve(rawRoot, relativePath.replaceAll("/", sep));
    if (!isPathInside(rawRoot, target) || !existsSync(target)) return;
    try {
      assertSafeRegularFile(target, "头像文件");
    } catch {
      return;
    }
    const mimeType = supportedAvatarMimeType(
      firstString(record.mimeType, record.mimetype),
      target,
    );
    if (mimeType === null) return;
    assets.push({
      nativeId,
      opaqueId: avatarOpaqueId(sourceId, nativeId, index, relativePath),
      path: target,
      mimeType,
      fileName: firstString(record.originalFileName, record.fileName) ?? basename(target),
    });
  });
  return assets;
}

function supportedAvatarMimeType(rawMimeType: string | null, path: string): string | null {
  const normalized = rawMimeType?.split(";", 1)[0]?.trim().toLocaleLowerCase("en-US") ?? "";
  if (["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"].includes(normalized)) {
    return normalized;
  }
  switch (extname(path).toLocaleLowerCase("en-US")) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".avif":
      return "image/avif";
    default:
      return null;
  }
}

function avatarOpaqueId(
  sourceId: string,
  nativeId: string,
  index: number,
  relativePath: string,
): string {
  const bytes = createHash("sha256")
    .update(["avatar", sourceId, nativeId, String(index), relativePath].join("\0"))
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function channelMediaKey(channelId: string, messageId: string): string {
  return `${channelId}\0${messageId}`;
}

function nullableInteger(...values: unknown[]): number | null {
  const value = nonnegativeNumber(...values);
  return value === null ? null : Math.trunc(value);
}

function readOptionalJson(root: string, ...segments: string[]): JsonFileResult {
  const path = resolve(root, ...segments);
  assertPathInside(root, path, "检材数据文件");
  if (!existsSync(path)) return { present: false, value: null, error: null, tooLarge: false };
  try {
    assertSafeRegularFile(path, "检材数据文件");
    if (statSync(path).size > SOURCE_FEATURE_FILE_LIMIT_BYTES) {
      return { present: true, value: null, error: "数据文件超过预览读取上限。", tooLarge: true };
    }
    return {
      present: true,
      value: JSON.parse(readFileSync(path, "utf8")) as unknown,
      error: null,
      tooLarge: false,
    };
  } catch {
    return { present: true, value: null, error: "数据文件无法解析。", tooLarge: false };
  }
}

function featureAvailability(
  dataset: string,
  file: JsonFileResult,
  recordCount: number,
  truncated: boolean,
  capabilities: unknown,
): SourceFeatureAvailability {
  if (file.error !== null) {
    return { status: "error", reason: file.error, truncated: truncated || file.tooLarge };
  }
  if (file.present) {
    return {
      status: recordCount > 0 ? "available" : "empty",
      reason: null,
      truncated,
    };
  }
  const datasets = asRecord(asRecord(capabilities)?.datasets);
  const capability = asRecord(datasets?.[dataset]);
  const status = firstString(capability?.status);
  if (status === "supported") return { status: "empty", reason: null, truncated: false };
  if (status === "error") {
    return { status: "error", reason: "采集阶段未能读取该类数据。", truncated: false };
  }
  if (status === "skipped") {
    return { status: "unavailable", reason: "该次采集未包含此类数据。", truncated: false };
  }
  return { status: "unavailable", reason: "采集结果未提供该类数据。", truncated: false };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((record): record is Record<string, unknown> => record !== null)
    : [];
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function readRawChatPhoneIdentities(rawRoot: string): Array<{
  nativeId: string;
  phoneNumber: string | null;
  formattedPhoneNumber: string | null;
}> {
  const chatsRoot = resolve(rawRoot, "chats");
  assertPathInside(rawRoot, chatsRoot, "聊天数据目录");
  if (!existsSync(chatsRoot)) return [];
  try {
    assertSafeDirectory(chatsRoot, "聊天数据目录");
  } catch {
    return [];
  }
  const identities: Array<{
    nativeId: string;
    phoneNumber: string | null;
    formattedPhoneNumber: string | null;
  }> = [];
  for (const entry of readdirSync(chatsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const chatRoot = resolve(chatsRoot, entry.name);
    if (!isPathInside(chatsRoot, chatRoot)) continue;
    try {
      assertSafeDirectory(chatRoot, "聊天数据目录");
    } catch {
      continue;
    }
    const record = asRecord(readOptionalJson(chatRoot, "chat.json").value);
    const nativeId = firstString(record?.id);
    if (record === null || nativeId === null) continue;
    const phone = phoneIdentityFromRawRecord(record);
    if (phone.phoneNumber === null && phone.formattedPhoneNumber === null) continue;
    identities.push({ nativeId, ...phone });
  }
  return identities;
}

function phoneIdentityFromRawRecord(record: Record<string, unknown>): {
  phoneNumber: string | null;
  formattedPhoneNumber: string | null;
} {
  const phoneNumber = [
    record.phoneNumber,
    record.phoneId,
    record.devicePhoneId,
    record.formattedPhoneNumber,
    record.id,
  ].map(rawPhoneDigits).find((value) => value !== null) ?? null;
  if (phoneNumber === null) return { phoneNumber: null, formattedPhoneNumber: null };
  const formattedCandidate = firstString(record.formattedPhoneNumber);
  return {
    phoneNumber,
    formattedPhoneNumber: rawPhoneDigits(formattedCandidate) === phoneNumber
      ? formattedCandidate
      : `+${phoneNumber}`,
  };
}

function rawPhoneDigits(value: unknown): string | null {
  const text = firstString(value);
  if (text === null) return null;
  const wid = text.match(/^(\+?\d{7,15})(?:(?::|_)\d+)?@(?:c\.us|s\.whatsapp\.net)$/iu);
  if (wid?.[1]) return wid[1].replace(/^\+/u, "");
  if (text.includes("@") || !/^[+\d\s().-]+$/u.test(text)) return null;
  const digits = text.replace(/\D/gu, "");
  return /^\d{7,15}$/u.test(digits) ? digits : null;
}

function nonnegativeNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function booleanValue(...values: unknown[]): boolean {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (value === 1 || value === "1" || value === "true") return true;
  }
  return false;
}

function nullableBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return null;
}

function titleForNativeId(
  nativeId: string | null,
  chatTitles: ReadonlyMap<string, string>,
  fallback: string,
): string {
  if (nativeId === null) return fallback;
  const known = chatTitles.get(nativeId);
  if (known !== undefined && known.trim() !== "") return known;
  const compact = nativeId.replace(/@(c\.us|g\.us|lid|newsletter)$/iu, "");
  return compact === "" ? fallback : compact;
}

function compareTimestampDescending(left: string | null, right: string | null): number {
  return (right ?? "").localeCompare(left ?? "");
}

function compareTimestampAscending(left: string | null, right: string | null): number {
  return (left ?? "").localeCompare(right ?? "");
}
