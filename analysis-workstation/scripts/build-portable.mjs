import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";

const VERSION = "0.1.8";
const RELEASE_NAME = `wafc-analysis-workstation-v${VERSION}-windows-x64`;
const analysisRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(analysisRoot, "..");
const outRoot = resolve(analysisRoot, "out");
const finalRoot = resolve(outRoot, RELEASE_NAME);
const zipPath = resolve(outRoot, `${RELEASE_NAME}.zip`);
const stagingRoot = resolve(
  outRoot,
  `.${RELEASE_NAME}.${randomUUID()}.partial`,
);
const desktopRoot = resolve(analysisRoot, "apps/desktop");
const requireFromDesktop = createRequire(resolve(desktopRoot, "package.json"));
const electronExecutable = requireFromDesktop("electron");
const electronRuntime = dirname(electronExecutable);
const collectorRelease = resolve(
  repositoryRoot,
  "field-collector/out/whatsapp-field-collector-v0.2.6-windows-x86_64",
);

function fail(message) {
  throw new Error(message);
}

function assertFile(path, label) {
  if (!existsSync(path)) fail(`${label}不存在：${path}`);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${label}必须是普通文件：${path}`);
  }
}

function assertSafeTree(root, label) {
  if (!existsSync(root)) fail(`${label}不存在：${root}`);
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) fail(`${label}包含符号链接或联接点：${current}`);
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
    !basename(path).startsWith(`.${RELEASE_NAME}.`) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  ) {
    fail(`拒绝清理越界路径：${path}`);
  }
  rmSync(path, { recursive: true, force: true });
}

function runGit(arguments_) {
  const result = spawnSync("git", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) fail(`git ${arguments_.join(" ")} 执行失败`);
  return result.stdout.trim();
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function inventory(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name, "en"),
    )) {
      const path = join(current, entry.name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) fail(`发行物包含链接：${path}`);
      if (metadata.isDirectory()) {
        pending.push(path);
      } else if (metadata.isFile()) {
        const relativePath = relative(root, path).split(sep).join("/");
        if (relativePath !== "release-manifest.json") {
          files.push({
            path: relativePath,
            bytes: metadata.size,
            sha256: await sha256File(path),
          });
        }
      } else {
        fail(`发行物包含特殊文件：${path}`);
      }
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

mkdirSync(outRoot, { recursive: true });
if (existsSync(finalRoot) || existsSync(zipPath)) {
  fail(`发行目标已存在，请先人工确认并移走：${finalRoot}`);
}

const requiredFiles = {
  desktopPackage: resolve(desktopRoot, "package.json"),
  desktopMain: resolve(desktopRoot, "dist/electron/main/index.cjs"),
  desktopPreload: resolve(desktopRoot, "dist/electron/preload/index.cjs"),
  desktopRenderer: resolve(desktopRoot, "dist/renderer/index.html"),
  provisioner: resolve(
    analysisRoot,
    "tools/usb-provisioner/target/release/wafc-usb-provisioner.exe",
  ),
  verifier: resolve(repositoryRoot, "tools/verify-cli/target/release/waeb-verify.exe"),
  license: resolve(repositoryRoot, "LICENSE"),
  readme: resolve(analysisRoot, "README.md"),
  notices: resolve(analysisRoot, "THIRD_PARTY_NOTICES.md"),
};
for (const [label, path] of Object.entries(requiredFiles)) assertFile(path, label);
assertSafeTree(electronRuntime, "Electron 运行时");
assertSafeTree(resolve(desktopRoot, "dist"), "桌面应用构建产物");
assertSafeTree(collectorRelease, "Field Collector 发行物");
assertSafeTree(resolve(analysisRoot, "docs"), "验收文档");

try {
  cpSync(electronRuntime, stagingRoot, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
  });
  const originalExecutable = join(stagingRoot, "electron.exe");
  assertFile(originalExecutable, "Electron 主程序");
  renameSync(
    originalExecutable,
    join(stagingRoot, "WAFC Analysis Workstation.exe"),
  );

  const appRoot = join(stagingRoot, "resources", "app");
  mkdirSync(appRoot, { recursive: false });
  copyFileSync(requiredFiles.desktopPackage, join(appRoot, "package.json"));
  cpSync(resolve(desktopRoot, "dist"), join(appRoot, "dist"), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });

  const toolsRoot = join(stagingRoot, "resources", "tools");
  mkdirSync(toolsRoot, { recursive: false });
  copyFileSync(requiredFiles.provisioner, join(toolsRoot, "wafc-usb-provisioner.exe"));
  copyFileSync(requiredFiles.verifier, join(toolsRoot, "waeb-verify.exe"));
  cpSync(
    collectorRelease,
    join(stagingRoot, "resources", "field-collector-portable"),
    { recursive: true, errorOnExist: true, force: false },
  );
  copyFileSync(requiredFiles.license, join(stagingRoot, "LICENSE"));
  copyFileSync(requiredFiles.readme, join(stagingRoot, "README.md"));
  copyFileSync(requiredFiles.notices, join(stagingRoot, "THIRD_PARTY_NOTICES.md"));
  cpSync(resolve(analysisRoot, "docs"), join(stagingRoot, "docs"), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });

  const collectorManifest = JSON.parse(
    readFileSync(resolve(collectorRelease, "release-manifest.json"), "utf8"),
  );
  const sourceCommit = runGit(["rev-parse", "HEAD"]);
  const dirty = runGit(["status", "--porcelain", "--untracked-files=normal"]) !== "";
  const tags = runGit(["tag", "--points-at", "HEAD"])
    .split(/\r?\n/u)
    .filter(Boolean)
    .sort();
  const exactTag = `analysis-workstation-v${VERSION}`;
  const collectorPublishable = collectorManifest?.source?.publishable === true;
  const publishable = !dirty && tags.includes(exactTag) && collectorPublishable;
  const files = await inventory(stagingRoot);
  const manifest = {
    schemaVersion: "wafc-analysis-workstation-release/1",
    releaseVersion: VERSION,
    platform: "windows-x64",
    generatedAtUtc: new Date().toISOString(),
    source: {
      commit: sourceCommit,
      dirty,
      tags,
      requiredTag: exactTag,
      publishable,
    },
    fieldCollector: {
      releaseVersion: collectorManifest?.releaseVersion ?? "unknown",
      publishable: collectorPublishable,
    },
    files,
  };
  writeFileSync(
    join(stagingRoot, "release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  renameSync(stagingRoot, finalRoot);

  const archive = spawnSync(
    "tar.exe",
    ["-a", "-c", "-f", zipPath, basename(finalRoot)],
    {
      cwd: outRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    },
  );
  if (archive.status !== 0) {
    fail(`ZIP 生成失败：${archive.stderr || archive.stdout}`);
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        directory: finalRoot,
        zip: zipPath,
        zipSha256: await sha256File(zipPath),
        payloadFiles: files.length,
        publishable,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  if (existsSync(stagingRoot)) safeCleanup(stagingRoot);
  throw error;
}
