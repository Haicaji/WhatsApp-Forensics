import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { dirname, join, posix, resolve } from "node:path";

import {
  type InitializeWorkstationInput,
  type ProvisionUsbInput,
  type ProvisioningReceipt,
  type WorkstationProfile,
  initializeWorkstationInputSchema,
  provisionUsbInputSchema,
  provisioningReceiptSchema,
  workstationProfileSchema,
} from "@wafc/domain";
import { z } from "zod";

import { type WorkstationCatalog } from "./catalog";
import {
  assertContained,
  assertRealDirectory,
  assertRealFile,
} from "./paths";
import { runJsonRpc } from "./process";

const COLLECTOR_DIRECTORY_NAME = "Field Collector";

const releaseManifestSchema = z.object({
  schemaVersion: z.string(),
  releaseVersion: z.string(),
  source: z.object({
    publishable: z.boolean(),
  }),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(240),
        bytes: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/u),
      }),
    )
    .min(2)
    .max(256),
});

const operatorRegistrySchema = z.object({
  schemaVersion: z.literal("wafc-operator-registry-entry/1"),
  operatorId: z.string(),
  displayName: z.string(),
  organization: z.string(),
  keyId: z.string(),
  publicKeySpkiBase64: z.string().min(1),
  fingerprintSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  createdAtUtc: z.string(),
});

export type ProvisionUsbResult = ProvisioningReceipt & {
  collectorDirectory: string;
  releasePublishable: boolean;
};

function readJsonLimited(path: string, maxBytes = 2 * 1024 * 1024): unknown {
  const file = assertRealFile(path, "JSON 文件");
  const metadata = lstatSync(file);
  if (metadata.size > maxBytes) throw new Error("JSON 文件超过大小上限");
  return JSON.parse(readFileSync(file, "utf8"));
}

function validateReleasePath(path: string): string {
  if (
    path.includes("\\") ||
    path.startsWith("/") ||
    path.includes(":") ||
    posix.normalize(path) !== path ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`发行清单包含不安全路径：${path}`);
  }
  return path;
}

function sha256File(path: string): string {
  const bytes = readFileSync(path);
  return createHash("sha256").update(bytes).digest("hex");
}

function copyReleasePayload(
  releaseRoot: string,
  destination: string,
): { publishable: boolean } {
  const source = assertRealDirectory(releaseRoot, "Field Collector 发行目录");
  const manifestSource = join(source, "release-manifest.json");
  const manifest = releaseManifestSchema.parse(readJsonLimited(manifestSource));
  const seen = new Set<string>();
  mkdirSync(destination, { recursive: false });
  const destinationRoot = assertRealDirectory(
    destination,
    "U 盘临时发行目录",
  );
  for (const entry of manifest.files) {
    const relativePath = validateReleasePath(entry.path);
    if (relativePath === "release-manifest.json" || seen.has(relativePath)) {
      throw new Error("发行清单包含自身或重复路径");
    }
    seen.add(relativePath);
    const sourceFile = resolve(source, ...relativePath.split("/"));
    assertContained(source, sourceFile, "发行文件");
    assertRealFile(sourceFile, "发行文件");
    const metadata = lstatSync(sourceFile);
    if (metadata.size !== entry.bytes || sha256File(sourceFile) !== entry.sha256) {
      throw new Error(`发行文件与清单不一致：${relativePath}`);
    }
    const destinationFile = resolve(
      destinationRoot,
      ...relativePath.split("/"),
    );
    assertContained(destinationRoot, destinationFile, "U 盘发行文件");
    mkdirSync(dirname(destinationFile), { recursive: true });
    const destinationParent = assertRealDirectory(
      dirname(destinationFile),
      "U 盘发行文件父目录",
    );
    assertContained(destinationRoot, destinationParent, "U 盘发行文件父目录");
    copyFileSync(sourceFile, destinationFile, fsConstants.COPYFILE_EXCL);
    if (sha256File(destinationFile) !== entry.sha256) {
      throw new Error(`U 盘写入后哈希不一致：${relativePath}`);
    }
  }
  const destinationManifest = join(destinationRoot, "release-manifest.json");
  copyFileSync(manifestSource, destinationManifest, fsConstants.COPYFILE_EXCL);
  if (sha256File(destinationManifest) !== sha256File(manifestSource)) {
    throw new Error("U 盘发行清单写入后哈希不一致");
  }
  if (!seen.has("field-collector.exe") || !seen.has("waeb-verify.exe")) {
    throw new Error("发行清单缺少 Field Collector 或独立校验器");
  }
  if (![...seen].some((path) => path === "extension/manifest.json")) {
    throw new Error("发行清单缺少只读取证扩展");
  }
  return { publishable: manifest.source.publishable };
}

export class ProvisioningService {
  readonly #catalog: WorkstationCatalog;
  readonly #provisionerExecutable: string;
  readonly #collectorReleaseDirectory: string;

  constructor(input: {
    catalog: WorkstationCatalog;
    provisionerExecutable: string;
    collectorReleaseDirectory: string;
  }) {
    this.#catalog = input.catalog;
    this.#provisionerExecutable = assertRealFile(
      input.provisionerExecutable,
      "USB Provisioner",
    );
    this.#collectorReleaseDirectory = assertRealDirectory(
      input.collectorReleaseDirectory,
      "Field Collector 发行目录",
    );
  }

  getWorkstationProfile(): WorkstationProfile | null {
    const profilePath = join(
      this.#catalog.provisioningStateDir,
      "workstation-profile.json",
    );
    if (!existsSync(profilePath)) return null;
    return workstationProfileSchema.parse(readJsonLimited(profilePath));
  }

  async initializeWorkstation(
    input: InitializeWorkstationInput,
  ): Promise<WorkstationProfile> {
    const parsed = initializeWorkstationInputSchema.parse(input);
    if (parsed.passphrase !== parsed.passphraseConfirmation) {
      throw new Error("两次 Workstation 密钥口令不一致");
    }
    if (this.getWorkstationProfile()) {
      throw new Error("Workstation 配置签名身份已经初始化");
    }
    return workstationProfileSchema.parse(
      await runJsonRpc<unknown>(this.#provisionerExecutable, {
        method: "initializeWorkstation",
        stateDir: this.#catalog.provisioningStateDir,
        workstationId: parsed.workstationId,
        keyId: parsed.keyId,
        passphrase: parsed.passphrase,
        createdAtUtc: new Date().toISOString(),
      }),
    );
  }

  async provisionUsb(input: ProvisionUsbInput): Promise<ProvisionUsbResult> {
    const parsed = provisionUsbInputSchema.parse(input);
    if (parsed.operatorPassphrase !== parsed.operatorPassphraseConfirmation) {
      throw new Error("两次勘察员密钥口令不一致");
    }
    const caseSummary = this.#catalog.getCase(parsed.caseId);
    if (!caseSummary) throw new Error(`案件 ${parsed.caseId} 不存在`);
    if (
      parsed.assignment.authorizationReference !==
        caseSummary.authorizationReference ||
      parsed.assignment.sourceOrganization !== caseSummary.organization
    ) {
      throw new Error("任务授权引用或来源机构与案件不一致");
    }
    const validFrom = new Date(parsed.assignment.validFromUtc);
    const validUntil = new Date(parsed.assignment.validUntilUtc);
    const now = new Date();
    if (
      !Number.isFinite(validFrom.getTime()) ||
      !Number.isFinite(validUntil.getTime()) ||
      now > validFrom ||
      validFrom >= validUntil
    ) {
      throw new Error("任务有效期必须从当前时间之后开始，且结束时间晚于开始时间");
    }
    if (this.#catalog.findAssignment(parsed.assignment.assignmentId)) {
      throw new Error(`任务 ${parsed.assignment.assignmentId} 已存在`);
    }

    const usbRoot = assertRealDirectory(parsed.usbRoot, "U 盘根目录");
    const finalDirectory = join(usbRoot, COLLECTOR_DIRECTORY_NAME);
    if (existsSync(finalDirectory)) {
      throw new Error(
        `U 盘中已经存在 ${COLLECTOR_DIRECTORY_NAME} 文件夹；为避免覆盖，请更换空白任务目录或先完成回收归档`,
      );
    }
    const bundleId = randomUUID();
    const stagingDirectory = join(
      usbRoot,
      `.${COLLECTOR_DIRECTORY_NAME}.${bundleId}.partial`,
    );
    if (existsSync(stagingDirectory)) {
      throw new Error("U 盘中存在同名未完成配置目录");
    }
    const release = copyReleasePayload(
      this.#collectorReleaseDirectory,
      stagingDirectory,
    );
    const createdAtUtc = now.toISOString();
    const receipt = provisioningReceiptSchema.parse(
      await runJsonRpc<unknown>(this.#provisionerExecutable, {
        method: "provisionUsb",
        stateDir: this.#catalog.provisioningStateDir,
        collectorRoot: stagingDirectory,
        bundleId,
        operator: {
          schemaVersion: "wafc-operator-template/1",
          operatorId: parsed.operator.operatorId,
          displayName: parsed.operator.displayName,
          organization: parsed.operator.organization,
          keyId: parsed.operator.keyId,
        },
        assignments: [
          {
            schemaVersion: "wafc-assignment-template/1",
            assignmentId: parsed.assignment.assignmentId,
            authorizationReference: parsed.assignment.authorizationReference,
            sourceOrganization: parsed.assignment.sourceOrganization,
            issuedAtUtc: createdAtUtc,
            validFromUtc: parsed.assignment.validFromUtc,
            validUntilUtc: parsed.assignment.validUntilUtc,
            targetDescription: parsed.assignment.targetDescription,
          },
        ],
        workstationPassphrase: parsed.workstationPassphrase,
        operatorPassphrase: parsed.operatorPassphrase,
        createdAtUtc,
      }),
    );
    if (existsSync(finalDirectory)) {
      throw new Error("配置完成前目标 Field Collector 文件夹被其他程序创建");
    }
    renameSync(stagingDirectory, finalDirectory);

    const operatorRegistryPath = join(
      this.#catalog.provisioningStateDir,
      "operators",
      `${parsed.operator.operatorId}--${parsed.operator.keyId}.json`,
    );
    const registry = operatorRegistrySchema.parse(
      readJsonLimited(operatorRegistryPath),
    );
    if (
      registry.fingerprintSha256 !== receipt.operatorKeyFingerprintSha256 ||
      registry.operatorId !== parsed.operator.operatorId ||
      registry.keyId !== parsed.operator.keyId
    ) {
      throw new Error("Provisioner 收据与勘察员公钥登记不一致");
    }
    this.#catalog.registerAssignment({
      assignmentId: parsed.assignment.assignmentId,
      caseId: parsed.caseId,
      operatorId: parsed.operator.operatorId,
      operatorKeyId: parsed.operator.keyId,
      operatorFingerprint: receipt.operatorKeyFingerprintSha256,
      bundleId: receipt.bundleId,
      authorizationReference: parsed.assignment.authorizationReference,
      validFromUtc: parsed.assignment.validFromUtc,
      validUntilUtc: parsed.assignment.validUntilUtc,
      operatorDisplayName: parsed.operator.displayName,
      operatorOrganization: parsed.operator.organization,
      operatorPublicKeySpkiBase64: registry.publicKeySpkiBase64,
      receiptJson: JSON.stringify(receipt),
      registeredAtUtc: createdAtUtc,
    });
    return {
      ...receipt,
      collectorDirectory: finalDirectory,
      releasePublishable: release.publishable,
    };
  }
}
