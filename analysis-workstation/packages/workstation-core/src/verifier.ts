import { z } from "zod";

import { fingerprintSchema, sha256Schema, uuidSchema } from "@wafc/domain";

import { runBoundedProcess } from "./process";

const verificationReportSchema = z.object({
  status: z.enum(["valid_untrusted", "valid_trusted"]),
  waEvidenceBagVersion: z.string(),
  evidenceId: uuidSchema,
  manifestRootSha256: sha256Schema,
  payloadFiles: z.number().int().nonnegative(),
  payloadBytes: z.number().int().nonnegative(),
  tagFiles: z.number().int().nonnegative(),
  normalizedRecords: z.number().int().nonnegative(),
  datasets: z.number().int().nonnegative(),
  mediaAssets: z.number().int().nonnegative(),
  logEvents: z.number().int().nonnegative(),
  chatCompletenessRecords: z.number().int().nonnegative(),
  signature: z.object({
    mathematicalValidity: z.literal(true),
    trusted: z.boolean(),
    fingerprint: fingerprintSchema,
  }),
});

export type VerificationReport = z.infer<typeof verificationReportSchema>;

export class EvidenceVerifier {
  readonly #executable: string;

  constructor(executable: string) {
    this.#executable = executable;
  }

  async verify(
    bagPath: string,
    trustedFingerprint?: string,
  ): Promise<VerificationReport> {
    if (trustedFingerprint) fingerprintSchema.parse(trustedFingerprint);
    const arguments_ = [bagPath];
    if (trustedFingerprint) {
      arguments_.push("--trusted-fingerprint", trustedFingerprint);
    }
    const result = await runBoundedProcess({
      executable: this.#executable,
      arguments: arguments_,
      timeoutMs: 300_000,
      maxStdoutBytes: 2 * 1024 * 1024,
      maxStderrBytes: 256 * 1024,
    });
    let report: VerificationReport;
    try {
      report = verificationReportSchema.parse(
        JSON.parse(result.stdout.toString("utf8")),
      );
    } catch {
      throw new Error("独立校验器未返回可信的结构化报告");
    }
    if (result.exitCode !== 0) {
      throw new Error("独立校验器拒绝该 Evidence Bag");
    }
    if (trustedFingerprint) {
      if (
        report.status !== "valid_trusted" ||
        !report.signature.trusted ||
        report.signature.fingerprint !== trustedFingerprint
      ) {
        throw new Error("Evidence Bag 签名有效，但不属于当前工作站登记的勘察员密钥");
      }
    } else if (
      report.status !== "valid_untrusted" &&
      report.status !== "valid_trusted"
    ) {
      throw new Error("Evidence Bag 未通过数学签名校验");
    }
    return report;
  }
}

