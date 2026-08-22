import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";

const VERSION = "0.1.38";
const RELEASE_NAME = `wafc-analysis-workstation-v${VERSION}-windows-x64`;
const analysisRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(analysisRoot, "..");
const desktopRoot = resolve(analysisRoot, "apps/desktop");
const outRoot = resolve(analysisRoot, "out");
const finalRoot = resolve(outRoot, RELEASE_NAME);
const zipPath = resolve(outRoot, `${RELEASE_NAME}.zip`);
const staging = resolve(outRoot, `.${RELEASE_NAME}-${randomUUID()}.partial`);
const requireFromDesktop = createRequire(resolve(desktopRoot, "package.json"));
const electronExecutable = requireFromDesktop("electron");
const electronRuntime = dirname(electronExecutable);

function fail(message) {
  throw new Error(message);
}

function assertFile(path, label) {
  if (!existsSync(path)) fail(`${label}不存在：${path}`);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`${label}必须是普通文件：${path}`);
}

function assertSafeTree(root, label) {
  if (!existsSync(root)) fail(`${label}不存在：${root}`);
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) fail(`${label}包含链接：${current}`);
    if (metadata.isDirectory()) {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        pending.push(join(current, entry.name));
      }
    } else if (!metadata.isFile()) {
      fail(`${label}包含特殊文件：${current}`);
    }
  }
}

function safeCleanup(path) {
  const relativePath = relative(outRoot, path);
  if (
    dirname(path) !== outRoot ||
    !basename(path).startsWith(`.${RELEASE_NAME}-`) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  ) {
    fail(`拒绝清理越界目录：${path}`);
  }
  rmSync(path, { recursive: true, force: true });
}

async function sha256(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function inventory(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) fail(`发行物包含链接：${path}`);
      if (metadata.isDirectory()) pending.push(path);
      else if (metadata.isFile()) {
        const relativePath = relative(root, path).split(sep).join("/");
        if (relativePath !== "release-manifest.json") {
          files.push({ path: relativePath, bytes: metadata.size, sha256: await sha256(path) });
        }
      }
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

const requiredFiles = {
  desktopPackage: resolve(desktopRoot, "package.json"),
  desktopMain: resolve(desktopRoot, "dist/electron/main/index.cjs"),
  desktopPreload: resolve(desktopRoot, "dist/electron/preload/index.cjs"),
  desktopRenderer: resolve(desktopRoot, "dist/renderer/index.html"),
  license: resolve(repositoryRoot, "LICENSE"),
  readme: resolve(analysisRoot, "README.md"),
  notices: resolve(analysisRoot, "THIRD_PARTY_NOTICES.md"),
};
for (const [label, path] of Object.entries(requiredFiles)) assertFile(path, label);
assertSafeTree(electronRuntime, "Electron runtime");
assertSafeTree(resolve(desktopRoot, "dist"), "桌面构建产物");
assertSafeTree(resolve(analysisRoot, "resources/field-collector-payload"), "Field Collector 载荷");
mkdirSync(outRoot, { recursive: true });
if (existsSync(finalRoot) || existsSync(zipPath)) {
  fail(`发行目标已存在，请人工确认并移走：${finalRoot}`);
}

try {
  cpSync(electronRuntime, staging, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
  });
  const electronExe = resolve(staging, "electron.exe");
  assertFile(electronExe, "Electron executable");
  renameSync(electronExe, resolve(staging, "WAFC Analysis Workstation.exe"));

  const appRoot = resolve(staging, "resources/app");
  mkdirSync(appRoot, { recursive: false });
  copyFileSync(requiredFiles.desktopPackage, resolve(appRoot, "package.json"));
  cpSync(resolve(desktopRoot, "dist"), resolve(appRoot, "dist"), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  cpSync(
    resolve(analysisRoot, "resources/field-collector-payload"),
    resolve(staging, "resources/field-collector-payload"),
    { recursive: true, errorOnExist: true, force: false },
  );
  copyFileSync(requiredFiles.license, resolve(staging, "LICENSE"));
  copyFileSync(requiredFiles.readme, resolve(staging, "README.md"));
  copyFileSync(requiredFiles.notices, resolve(staging, "THIRD_PARTY_NOTICES.md"));

  const files = await inventory(staging);
  writeFileSync(
    resolve(staging, "release-manifest.json"),
    `${JSON.stringify({
      schemaVersion: "wafc-analysis-workstation-release/1",
      releaseVersion: VERSION,
      platform: "windows-x64",
      generatedAtUtc: new Date().toISOString(),
      source: { commit: gitValue(["rev-parse", "HEAD"]), dirty: gitValue(["status", "--porcelain"]) !== "" },
      files,
    }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  renameSync(staging, finalRoot);
  const archive = spawnSync("tar.exe", ["-a", "-c", "-f", zipPath, basename(finalRoot)], {
    cwd: outRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (archive.status !== 0) fail(`ZIP 生成失败：${archive.stderr || archive.stdout}`);
  process.stdout.write(`${JSON.stringify({
    directory: finalRoot,
    zip: zipPath,
    zipSha256: await sha256(zipPath),
    files: files.length,
  }, null, 2)}\n`);
} catch (error) {
  if (existsSync(staging)) safeCleanup(staging);
  throw error;
}

function gitValue(arguments_) {
  const result = spawnSync("git", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) return "unknown";
  return result.stdout.trim();
}
