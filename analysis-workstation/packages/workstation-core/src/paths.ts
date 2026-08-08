import {
  lstatSync,
  mkdirSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { identifierSchema } from "@wafc/domain";

export function assertRealDirectory(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label}必须是绝对路径`);
  let metadata: Stats;
  try {
    metadata = lstatSync(path);
  } catch {
    throw new Error(`${label}不存在或不可访问`);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label}必须是真实目录，不能是符号链接或联接点`);
  }
  return realpathSync.native(path);
}

export function ensureRealDirectory(path: string, label: string): string {
  mkdirSync(path, { recursive: true });
  return assertRealDirectory(path, label);
}

export function assertRealFile(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label}必须是绝对路径`);
  let metadata: Stats;
  try {
    metadata = lstatSync(path);
  } catch {
    throw new Error(`${label}不存在或不可访问`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label}必须是普通文件，不能是符号链接或联接点`);
  }
  return realpathSync.native(path);
}

export function safeCaseDirectory(dataRoot: string, caseId: string): string {
  const canonicalId = identifierSchema.parse(caseId);
  const casesRoot = ensureRealDirectory(join(dataRoot, "cases"), "案件目录");
  const candidate = resolve(casesRoot, canonicalId);
  assertContained(casesRoot, candidate, "案件目录");
  return candidate;
}

export function assertContained(
  parent: string,
  candidate: string,
  label: string,
): void {
  const pathFromParent = relative(resolve(parent), resolve(candidate));
  if (
    pathFromParent === "" ||
    (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== "..")
  ) {
    return;
  }
  throw new Error(`${label}越出允许的根目录`);
}

export function fixedCasePaths(dataRoot: string, caseId: string) {
  const root = safeCaseDirectory(dataRoot, caseId);
  return {
    root,
    database: join(root, "case.sqlite"),
    sources: join(root, "sources"),
    derived: join(root, "derived"),
    reports: join(root, "reports"),
    audit: join(root, "audit"),
  } as const;
}

