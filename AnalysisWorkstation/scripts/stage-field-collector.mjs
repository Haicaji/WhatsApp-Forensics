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
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

const analysisRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(analysisRoot, "..");
const fieldCollectorRoot = resolve(repositoryRoot, "FieldCollector");
const resourcesRoot = resolve(analysisRoot, "resources");
const target = resolve(resourcesRoot, "field-collector-payload");
const staging = resolve(resourcesRoot, `.field-collector-payload-${randomUUID()}.partial`);
const previous = resolve(resourcesRoot, `.field-collector-payload-${randomUUID()}.previous`);
const executable = resolve(
  fieldCollectorRoot,
  "target/release/field-collector-prototype.exe",
);
const extension = resolve(fieldCollectorRoot, "extension/dist");

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

function safeRemove(path) {
  const relativePath = relative(resourcesRoot, path);
  if (
    dirname(path) !== resourcesRoot ||
    !basename(path).startsWith(".field-collector-payload-") ||
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
      if (metadata.isSymbolicLink()) fail(`载荷包含链接：${path}`);
      if (metadata.isDirectory()) pending.push(path);
      else if (metadata.isFile()) {
        const relativePath = relative(root, path).split(sep).join("/");
        if (relativePath !== "payload-manifest.json") {
          files.push({
            path: relativePath,
            bytes: metadata.size,
            sha256: await sha256(path),
          });
        }
      }
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

assertFile(executable, "Field Collector release");
assertSafeTree(extension, "Field Collector extension");
assertFile(resolve(repositoryRoot, "LICENSE"), "LICENSE");
assertFile(resolve(fieldCollectorRoot, "THIRD_PARTY_NOTICES.md"), "Field Collector notices");
mkdirSync(resourcesRoot, { recursive: true });

try {
  mkdirSync(staging, { recursive: false });
  copyFileSync(executable, resolve(staging, "Field Collector.exe"));
  cpSync(extension, resolve(staging, "extension"), {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
  });
  copyFileSync(resolve(repositoryRoot, "LICENSE"), resolve(staging, "LICENSE"));
  copyFileSync(
    resolve(fieldCollectorRoot, "THIRD_PARTY_NOTICES.md"),
    resolve(staging, "THIRD_PARTY_NOTICES.md"),
  );
  const files = await inventory(staging);
  writeFileSync(
    resolve(staging, "payload-manifest.json"),
    `${JSON.stringify({
      schemaVersion: "wafc-field-collector-payload/1",
      generatedAtUtc: new Date().toISOString(),
      platform: "windows-x64",
      files,
    }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  if (existsSync(target)) renameSync(target, previous);
  renameSync(staging, target);
  if (existsSync(previous)) safeRemove(previous);
  process.stdout.write(`${JSON.stringify({ target, files: files.length }, null, 2)}\n`);
} catch (error) {
  if (existsSync(staging)) safeRemove(staging);
  if (existsSync(previous) && !existsSync(target)) renameSync(previous, target);
  throw error;
}
