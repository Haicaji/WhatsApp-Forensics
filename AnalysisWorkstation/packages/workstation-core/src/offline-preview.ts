import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { finished } from "node:stream/promises";
import { basename, dirname, extname, resolve } from "node:path";

import type {
  ChatSummary,
  EvidenceSource,
  MessageView,
  OfflinePreviewExportResult,
  SourceWorkspaceView,
} from "@wafc/domain";

import { WorkstationError } from "./errors.js";
import { assertSafeDirectory, assertSafeRegularFile } from "./safe-files.js";
import {
  buildOfflinePreviewDocumentEnd,
  buildOfflinePreviewDocumentStart,
} from "./offline-preview-template.js";

export type OfflinePreviewConversation = {
  chat: ChatSummary;
  messages: MessageView[];
};

export type OfflinePreviewDataset = {
  caseName: string;
  generatedAtUtc: string;
  displayTimeZone: string;
  source: EvidenceSource;
  workspace: SourceWorkspaceView;
  conversations: OfflinePreviewConversation[];
};

export type OfflinePreviewAssetSource = {
  assetId: string;
  path: string;
  mimeType: string | null;
  fileName: string | null;
};

export type WriteOfflinePreviewOptions = {
  targetPath: string;
  dataset: OfflinePreviewDataset;
  assets: OfflinePreviewAssetSource[];
};

export function createOfflinePreviewSuggestedFileName(specimenName: string): string {
  const safeName = specimenName
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
    .replace(/[. ]+$/gu, "")
    .trim()
    .slice(0, 120);
  return `${safeName === "" ? "WhatsApp账号" : safeName}-WhatsApp-离线预览.html`;
}

export async function writeOfflinePreview(
  options: WriteOfflinePreviewOptions,
): Promise<OfflinePreviewExportResult> {
  const targetPath = normalizeTargetPath(options.targetPath);
  const parentDirectory = dirname(targetPath);
  assertSafeDirectory(parentDirectory, "离线预览保存位置");

  const temporaryPath = resolve(
    parentDirectory,
    `.${basename(targetPath)}.${randomUUID()}.partial`,
  );
  const backupPath = resolve(
    parentDirectory,
    `.${basename(targetPath)}.${randomUUID()}.previous`,
  );
  const writer = createWriteStream(temporaryPath, { encoding: "utf8", flags: "wx" });

  try {
    await writeChunk(writer, buildOfflinePreviewDocumentStart(options.dataset, options.assets));
    for (const asset of options.assets) {
      assertSafeRegularFile(asset.path, "离线预览媒体文件");
      await writeChunk(
        writer,
        `<script type="application/octet-stream" id="offline-asset-${asset.assetId}">`,
      );
      const reader = createReadStream(asset.path).setEncoding("base64");
      for await (const chunk of reader) {
        await writeChunk(writer, chunk);
      }
      await writeChunk(writer, "</script>\n");
    }
    await writeChunk(writer, buildOfflinePreviewDocumentEnd());
    writer.end();
    await finished(writer);

    let movedExistingFile = false;
    if (existsSync(targetPath)) {
      assertSafeRegularFile(targetPath, "已有离线预览文件");
      renameSync(targetPath, backupPath);
      movedExistingFile = true;
    }
    try {
      renameSync(temporaryPath, targetPath);
    } catch (error) {
      if (movedExistingFile && existsSync(backupPath) && !existsSync(targetPath)) {
        renameSync(backupPath, targetPath);
      }
      throw error;
    }
    if (movedExistingFile && existsSync(backupPath)) unlinkSync(backupPath);

    return {
      path: targetPath,
      fileName: basename(targetPath),
      sizeBytes: statSync(targetPath).size,
    };
  } catch (error) {
    writer.destroy();
    try {
      await finished(writer);
    } catch {
      // The original failure is more useful than the stream shutdown error.
    }
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    if (existsSync(backupPath) && !existsSync(targetPath)) renameSync(backupPath, targetPath);
    throw error;
  }
}

function normalizeTargetPath(input: string): string {
  const resolved = resolve(input.trim());
  const extension = extname(resolved).toLocaleLowerCase("en-US");
  if (extension === "") return `${resolved}.html`;
  if (extension !== ".html" && extension !== ".htm") {
    throw new WorkstationError(
      "OFFLINE_PREVIEW_EXTENSION_INVALID",
      "离线预览只能保存为 HTML 文件。",
    );
  }
  return resolved;
}

async function writeChunk(
  writer: ReturnType<typeof createWriteStream>,
  chunk: string,
): Promise<void> {
  if (!writer.write(chunk, "utf8")) await once(writer, "drain");
}
