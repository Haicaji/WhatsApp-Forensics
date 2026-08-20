import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

import { WorkstationError } from "./errors.js";
import { assertPathInside, isPathInside, toPortableRelativePath } from "./paths.js";

export function assertSafeRegularFile(path: string, label = "文件"): void {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new WorkstationError("UNSAFE_FILE", `${label}必须是普通文件：${path}`);
  }
}

export function assertSafeDirectory(path: string, label = "目录"): void {
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new WorkstationError("UNSAFE_DIRECTORY", `${label}不能是链接或特殊目录：${path}`);
  }
}

export function walkSafeFiles(root: string): string[] {
  assertSafeDirectory(root);
  const files: string[] = [];
  const pending = [resolve(root)];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    assertPathInside(root, current);
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) {
        throw new WorkstationError("LINK_REJECTED", `结果目录包含链接：${path}`);
      }
      if (metadata.isDirectory()) pending.push(path);
      else if (metadata.isFile()) files.push(path);
      else throw new WorkstationError("SPECIAL_FILE_REJECTED", `结果目录包含特殊文件：${path}`);
    }
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

export async function copySafeTree(sourceRoot: string, targetRoot: string): Promise<void> {
  assertSafeDirectory(sourceRoot, "来源目录");
  if (existsSync(targetRoot)) {
    throw new WorkstationError("TARGET_EXISTS", `目标目录已存在：${targetRoot}`);
  }
  mkdirSync(targetRoot, { recursive: false });
  for (const source of walkSafeFiles(sourceRoot)) {
    const relativePath = relative(sourceRoot, source);
    const target = join(targetRoot, relativePath);
    assertPathInside(targetRoot, target, "复制目标");
    mkdirSync(dirname(target), { recursive: true });
    await pipeline(
      createReadStream(source),
      createWriteStream(target, { flags: "wx" }),
    );
  }
}

export function safeRemoveCreatedDirectory(parent: string, target: string): void {
  const resolvedParent = resolve(parent);
  const resolvedTarget = resolve(target);
  const relativePath = relative(resolvedParent, resolvedTarget);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    relativePath.includes(`${sep}..${sep}`) ||
    !isPathInside(resolvedParent, resolvedTarget)
  ) {
    throw new WorkstationError("UNSAFE_CLEANUP", `拒绝清理越界目录：${target}`);
  }
  rmSync(resolvedTarget, { recursive: true, force: true });
}

export async function fingerprintFiles(
  root: string,
  files: readonly string[],
): Promise<string> {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.localeCompare(right, "en"))) {
    assertPathInside(root, file, "指纹文件");
    assertSafeRegularFile(file, "指纹文件");
    const relativePath = toPortableRelativePath(relative(root, file));
    hash.update(`${relativePath.length}:${relativePath}:`);
    for await (const chunk of createReadStream(file)) hash.update(chunk);
  }
  return `sha256:${hash.digest("hex")}`;
}

export function stagingDirectory(parent: string, label: string): string {
  return join(parent, `.${basename(label)}-${randomUUID()}.partial`);
}
