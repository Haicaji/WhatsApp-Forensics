import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import type { PortableTask } from "@wafc/domain";

import { WorkstationError } from "./errors.js";
import {
  assertSafeDirectory,
  assertSafeRegularFile,
  copySafeTree,
  safeRemoveCreatedDirectory,
} from "./safe-files.js";

const REQUIRED_PAYLOAD_FILES = [
  "Field Collector.exe",
  "payload-manifest.json",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
] as const;

export type ProvisionedTask = {
  collectorDirectory: string;
};

export async function provisionPortableTask(
  usbRoot: string,
  payloadRoot: string,
  task: PortableTask,
): Promise<ProvisionedTask> {
  const root = resolve(usbRoot);
  assertSafeDirectory(root, "U 盘根目录");
  const target = join(root, "Field Collector");
  if (existsSync(target)) {
    throw new WorkstationError(
      "COLLECTOR_DIRECTORY_EXISTS",
      `所选位置已经存在 Field Collector。为避免覆盖，请更换空目录或另一只 U 盘：${target}`,
    );
  }
  assertPayload(payloadRoot);
  const staging = join(root, `.Field Collector-${randomUUID()}.partial`);
  if (existsSync(staging)) {
    throw new WorkstationError("STAGING_CONFLICT", `临时目录冲突：${staging}`);
  }

  try {
    await copySafeTree(payloadRoot, staging);
    mkdirSync(join(staging, "results"), { recursive: false });
    writeFileSync(join(staging, "task.json"), `${JSON.stringify(task, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    renameSync(staging, target);
    return { collectorDirectory: target };
  } catch (error) {
    if (existsSync(staging)) safeRemoveCreatedDirectory(root, staging);
    throw error;
  }
}

function assertPayload(payloadRoot: string): void {
  assertSafeDirectory(payloadRoot, "Field Collector 载荷目录");
  for (const file of REQUIRED_PAYLOAD_FILES) {
    const path = join(payloadRoot, file);
    if (!existsSync(path)) {
      throw new WorkstationError(
        "COLLECTOR_PAYLOAD_MISSING",
        `Field Collector 载荷不完整，缺少 ${file}。请先执行便携载荷构建。`,
      );
    }
    assertSafeRegularFile(path, file);
  }
  const extension = join(payloadRoot, "extension");
  if (!existsSync(extension) || !lstatSync(extension).isDirectory()) {
    throw new WorkstationError(
      "COLLECTOR_PAYLOAD_MISSING",
      "Field Collector 载荷缺少 extension 目录。",
    );
  }
  assertSafeDirectory(extension, "extension 目录");
}
