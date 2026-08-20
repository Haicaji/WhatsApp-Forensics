export class WorkstationError extends Error {
  readonly code: string;
  readonly userMessage: string;

  constructor(code: string, userMessage: string, cause?: unknown) {
    super(userMessage, cause === undefined ? undefined : { cause });
    this.name = "WorkstationError";
    this.code = code;
    this.userMessage = userMessage;
  }
}

export function toWorkstationError(error: unknown): WorkstationError {
  if (error instanceof WorkstationError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new WorkstationError("UNEXPECTED", `操作失败：${message}`, error);
}
