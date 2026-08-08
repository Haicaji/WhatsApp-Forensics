import { spawn } from "node:child_process";

import { assertRealFile } from "./paths";

type ProcessResult = {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
};

export type BoundedProcessOptions = {
  executable: string;
  arguments?: string[];
  stdin?: Buffer;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
};

export async function runBoundedProcess(
  options: BoundedProcessOptions,
): Promise<ProcessResult> {
  const executable = assertRealFile(options.executable, "后端工具");
  const timeoutMs = options.timeoutMs ?? 300_000;
  const maxStdout = options.maxStdoutBytes ?? 2 * 1024 * 1024;
  const maxStderr = options.maxStderrBytes ?? 256 * 1024;
  const child = spawn(executable, options.arguments ?? [], {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let limitError: Error | null = null;

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= maxStdout) stdout.push(chunk);
    else {
      limitError = new Error("后端工具 stdout 超过大小上限");
      child.kill();
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= maxStderr) stderr.push(chunk);
    else {
      limitError = new Error("后端工具 stderr 超过大小上限");
      child.kill();
    }
  });

  if (options.stdin) {
    child.stdin.end(options.stdin);
  } else {
    child.stdin.end();
  }

  return await new Promise<ProcessResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`后端工具超过 ${Math.ceil(timeoutMs / 1000)} 秒时限`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (limitError) {
        reject(limitError);
        return;
      }
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

export async function runJsonRpc<T>(
  executable: string,
  request: unknown,
): Promise<T> {
  const input = Buffer.from(JSON.stringify(request), "utf8");
  try {
    const result = await runBoundedProcess({
      executable,
      arguments: ["rpc"],
      stdin: input,
      maxStdoutBytes: 2 * 1024 * 1024,
      maxStderrBytes: 128 * 1024,
    });
    let response: unknown;
    try {
      response = JSON.parse(result.stdout.toString("utf8"));
    } catch {
      throw new Error("USB 配置后端未返回有效 JSON");
    }
    if (
      typeof response !== "object" ||
      response === null ||
      !("ok" in response)
    ) {
      throw new Error("USB 配置后端返回结构无效");
    }
    if (response.ok !== true) {
      const message =
        "error" in response &&
        typeof response.error === "object" &&
        response.error !== null &&
        "message" in response.error &&
        typeof response.error.message === "string"
          ? response.error.message
          : "USB 配置失败";
      throw new Error(message);
    }
    if (result.exitCode !== 0 || !("result" in response)) {
      throw new Error("USB 配置后端未成功完成操作");
    }
    return response.result as T;
  } finally {
    input.fill(0);
  }
}

