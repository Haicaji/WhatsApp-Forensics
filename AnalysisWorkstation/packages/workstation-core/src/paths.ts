import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { WorkstationError } from "./errors.js";

export type WorkstationPaths = {
  dataRoot: string;
  catalogPath: string;
  defaultCasesDirectory: string;
  electronUserData: string;
  electronSessionData: string;
  electronCrashDumps: string;
  logsDirectory: string;
};

export type ResolveDataRootOptions = {
  isPackaged: boolean;
  executablePath: string;
  projectRoot: string;
  environment?: NodeJS.ProcessEnv;
};

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export function resolveDataRoot(options: ResolveDataRootOptions): string {
  const override = options.environment?.WAFC_ANALYSIS_DATA_ROOT;
  if (override !== undefined) {
    if (!isAbsolute(override)) {
      throw new WorkstationError(
        "DATA_ROOT_NOT_ABSOLUTE",
        "WAFC_ANALYSIS_DATA_ROOT 必须是绝对路径。",
      );
    }
    return resolve(override);
  }
  const base = options.isPackaged
    ? dirname(resolve(options.executablePath))
    : resolve(options.projectRoot);
  return join(base, "AnalysisWorkstationData");
}

export function initializeWorkstationPaths(dataRoot: string): WorkstationPaths {
  const root = resolve(dataRoot);
  const paths: WorkstationPaths = {
    dataRoot: root,
    catalogPath: join(root, "catalog.sqlite"),
    defaultCasesDirectory: join(root, "Cases"),
    electronUserData: join(root, "Electron", "UserData"),
    electronSessionData: join(root, "Electron", "SessionData"),
    electronCrashDumps: join(root, "Electron", "CrashDumps"),
    logsDirectory: join(root, "Logs"),
  };
  try {
    for (const directory of [
      root,
      paths.defaultCasesDirectory,
      paths.electronUserData,
      paths.electronSessionData,
      paths.electronCrashDumps,
      paths.logsDirectory,
    ]) {
      mkdirSync(directory, { recursive: true });
    }
    const probe = join(root, `.wafc-write-probe-${randomUUID()}`);
    const descriptor = openSync(probe, "wx");
    writeFileSync(descriptor, "ok", { encoding: "utf8" });
    closeSync(descriptor);
    rmSync(probe, { force: true });
  } catch (error) {
    throw new WorkstationError(
      "DATA_ROOT_NOT_WRITABLE",
      `软件目录不可写：${root}。请把程序移动到可写目录后重试。`,
      error,
    );
  }
  return paths;
}

export function sanitizeCaseDirectoryName(name: string): string {
  let safe = name
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
    .replace(/\s+/gu, " ")
    .replace(/[. ]+$/gu, "")
    .trim();
  if (safe.length > 80) safe = safe.slice(0, 80).replace(/[. ]+$/gu, "");
  if (WINDOWS_RESERVED.test(safe)) safe = `_${safe}`;
  return safe || "未命名案件";
}

export function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

export function assertPathInside(root: string, candidate: string, label = "路径"): void {
  if (!isPathInside(root, candidate)) {
    throw new WorkstationError("PATH_ESCAPE", `${label}超出了允许目录。`);
  }
}

export function assertDirectory(path: string, label: string): void {
  try {
    const metadata = statSync(path);
    if (!metadata.isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw new WorkstationError("DIRECTORY_REQUIRED", `${label}不是可用目录：${path}`, error);
  }
}

export function toPortableRelativePath(path: string): string {
  return path.split(sep).join("/");
}
