import {
  ArchiveRestore,
  ArrowLeft,
  BriefcaseBusiness,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Database,
  FileCheck2,
  FileSearch,
  FolderInput,
  HardDriveDownload,
  KeyRound,
  ListFilter,
  LoaderCircle,
  LockKeyhole,
  MessageSquareText,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Usb,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import type {
  CaseSummary,
  Chat,
  IntegritySummary,
  Message,
  SearchHit,
  SourceSummary,
  UsbSoftwareInspection,
} from "@wafc/domain";

import type {
  ApiResult,
  AssignmentSummary,
  WorkstationStatus,
} from "../shared/api";

type CaseTab = "overview" | "chats" | "search" | "integrity";

type Notice = {
  kind: "success" | "error" | "info";
  message: string;
};

function formatDate(value: string | null | undefined): string {
  if (!value) return "未记录";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function shortFingerprint(value: string): string {
  if (value.length < 24) return value;
  return `${value.slice(0, 15)}…${value.slice(-8)}`;
}

function unwrap<T>(result: ApiResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timeout);
  }, [delay, value]);
  return debounced;
}

function Button({
  children,
  variant = "primary",
  icon,
  busy = false,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  icon?: ReactNode;
  busy?: boolean;
}) {
  return (
    <button
      {...props}
      className={`button button--${variant} ${props.className ?? ""}`}
      disabled={props.disabled || busy}
    >
      {busy ? <LoaderCircle className="spin" size={17} /> : icon}
      <span>{children}</span>
    </button>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

function Modal({
  title,
  description,
  onClose,
  children,
  wide = false,
  closeDisabled = false,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  closeDisabled?: boolean;
}) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !closeDisabled) onClose();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [closeDisabled, onClose]);
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className={`modal ${wide ? "modal--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <header className="modal__header">
          <div>
            <h2 id="modal-title">{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭"
            onClick={onClose}
            disabled={closeDisabled}
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function StatusBadge({ integrity }: { integrity: CaseSummary["integrity"] }) {
  const labels = {
    empty: "待接收证据",
    verified: "已验证",
    partial: "部分完整",
    failed: "存在失败",
  } as const;
  return (
    <span className={`status-badge status-badge--${integrity}`}>
      {integrity === "verified" ? (
        <CheckCircle2 size={14} />
      ) : (
        <CircleAlert size={14} />
      )}
      {labels[integrity]}
    </span>
  );
}

function Onboarding({
  onComplete,
}: {
  onComplete: (status: WorkstationStatus) => void;
}) {
  const [workstationId, setWorkstationId] = useState("lab-workstation-001");
  const [keyId, setKeyId] = useState("workstation-config-key-001");
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await window.wafc.initializeWorkstation({
          workstationId,
          keyId,
          passphrase,
          passphraseConfirmation: confirmation,
        }),
      );
      setPassphrase("");
      setConfirmation("");
      onComplete(unwrap(await window.wafc.status()));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "初始化失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="onboarding-shell">
      <section className="onboarding-card">
        <div className="brand-mark" aria-hidden="true">
          <ShieldCheck size={34} />
        </div>
        <p className="eyebrow">WAFC ANALYSIS WORKSTATION</p>
        <h1>建立实验室信任身份</h1>
        <p className="onboarding-card__lead">
          此密钥只用于签署勘察员配置和现场任务。勘察员证据私钥会单独加密写入取证 U
          盘，工作站默认不保留其私钥副本。
        </p>
        <form onSubmit={submit} className="form-stack">
          <div className="form-grid">
            <Field label="工作站编号">
              <input
                value={workstationId}
                onChange={(event) => setWorkstationId(event.target.value)}
                required
              />
            </Field>
            <Field label="配置签名密钥编号">
              <input
                value={keyId}
                onChange={(event) => setKeyId(event.target.value)}
                required
              />
            </Field>
          </div>
          <Field
            label="工作站密钥口令"
            hint="至少 8 个字符，并包含大写字母、小写字母、数字和符号；不会写入日志或数据库。"
          >
            <input
              type="password"
              autoComplete="new-password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              required
              minLength={8}
            />
          </Field>
          <Field label="再次输入口令">
            <input
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              required
              minLength={8}
            />
          </Field>
          {error ? <div className="inline-alert inline-alert--error">{error}</div> : null}
          <Button type="submit" busy={busy} icon={<KeyRound size={18} />}>
            初始化工作站
          </Button>
        </form>
      </section>
    </main>
  );
}

function CreateCaseModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (caseSummary: CaseSummary) => void;
}) {
  const [form, setForm] = useState({
    caseId: "",
    name: "",
    authorizationReference: "",
    organization: "",
    description: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = unwrap(await window.wafc.createCase(form));
      onCreated(created);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "案件创建失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="创建案件"
      description="案件只保存索引入口；聊天正文将进入该案件独立的 SQLite 数据库。"
      onClose={onClose}
    >
      <form className="form-stack modal__body" onSubmit={submit}>
        <div className="form-grid">
          <Field label="案件编号" hint="例如 CASE-2026-001">
            <input
              value={form.caseId}
              onChange={(event) => setForm({ ...form, caseId: event.target.value })}
              required
            />
          </Field>
          <Field label="案件名称">
            <input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              required
            />
          </Field>
        </div>
        <Field label="授权或案件引用">
          <input
            value={form.authorizationReference}
            onChange={(event) =>
              setForm({ ...form, authorizationReference: event.target.value })
            }
            required
          />
        </Field>
        <Field label="来源机构">
          <input
            value={form.organization}
            onChange={(event) => setForm({ ...form, organization: event.target.value })}
            required
          />
        </Field>
        <Field label="案件说明">
          <textarea
            rows={3}
            value={form.description}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
          />
        </Field>
        {error ? <div className="inline-alert inline-alert--error">{error}</div> : null}
        <footer className="modal__actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" busy={busy} icon={<Plus size={17} />}>
            创建案件
          </Button>
        </footer>
      </form>
    </Modal>
  );
}

function toLocalInput(date: Date): string {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function ProvisionUsbModal({
  caseSummary,
  onClose,
  onComplete,
}: {
  caseSummary: CaseSummary;
  onClose: () => void;
  onComplete: (message: string) => void;
}) {
  const now = useMemo(() => new Date(), []);
  const [usbRoot, setUsbRoot] = useState("");
  const [form, setForm] = useState({
    operatorId: "",
    displayName: "",
    organization: caseSummary.organization,
    keyId: "",
    assignmentId: `${caseSummary.caseId}-task-001`,
    validFrom: toLocalInput(new Date(now.getTime() + 5 * 60_000)),
    validUntil: toLocalInput(new Date(now.getTime() + 7 * 24 * 60 * 60_000)),
    targetDescription: "经授权的 WhatsApp Web 综合只读现场采集",
    workstationPassphrase: "",
    operatorPassphrase: "",
    operatorPassphraseConfirmation: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function chooseUsb() {
    try {
      const selected = unwrap(await window.wafc.chooseUsbRoot());
      if (selected) setUsbRoot(selected);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法选择 U 盘");
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!usbRoot) throw new Error("请先选择取证 U 盘根目录");
      const receipt = unwrap(
        await window.wafc.provisionUsb({
          caseId: caseSummary.caseId,
          usbRoot,
          operator: {
            operatorId: form.operatorId,
            displayName: form.displayName,
            organization: form.organization,
            keyId: form.keyId,
          },
          assignment: {
            assignmentId: form.assignmentId,
            authorizationReference: caseSummary.authorizationReference,
            sourceOrganization: caseSummary.organization,
            validFromUtc: new Date(form.validFrom).toISOString(),
            validUntilUtc: new Date(form.validUntil).toISOString(),
            acquisitionMode: "comprehensive_readonly_v02",
            mediaPolicy: {
              mode: "network_best_effort",
              maxAssetBytes: 2_147_483_648,
              maxTotalBytes: 21_474_836_480,
              cacheLookupTimeoutSeconds: 10,
              noProgressTimeoutSeconds: 120,
              attemptTimeoutSeconds: 600,
              maxAssetDurationSeconds: 1_200,
              maxAttempts: 2,
              continueOnFailure: true,
            },
            targetDescription: form.targetDescription,
          },
          workstationPassphrase: form.workstationPassphrase,
          operatorPassphrase: form.operatorPassphrase,
          operatorPassphraseConfirmation: form.operatorPassphraseConfirmation,
        }),
      );
      setForm({
        ...form,
        workstationPassphrase: "",
        operatorPassphrase: "",
        operatorPassphraseConfirmation: "",
      });
      onComplete(
        `取证 U 盘配置完成：${receipt.collectorDirectory}${
          receipt.releasePublishable ? "" : "（当前携带的是开发验收版 Collector）"
        }`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "U 盘配置失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="为案件创建取证 U 盘"
      description="不会删除 U 盘原有文件，只会在根目录新增一个 Field Collector 文件夹。"
      onClose={onClose}
      wide
    >
      <form className="form-stack modal__body" onSubmit={submit}>
        <section className="form-section">
          <div className="section-heading">
            <span>1</span>
            <div>
              <h3>选择 U 盘</h3>
              <p>应用自动放入采集程序、扩展、任务配置和加密私钥。</p>
            </div>
          </div>
          <div className="path-picker">
            <code>{usbRoot || "尚未选择"}</code>
            <Button
              type="button"
              variant="secondary"
              icon={<Usb size={17} />}
              onClick={chooseUsb}
            >
              选择 U 盘
            </Button>
          </div>
        </section>
        <section className="form-section">
          <div className="section-heading">
            <span>2</span>
            <div>
              <h3>勘察员与专属证据密钥</h3>
              <p>每名勘察员生成独立密钥；工作站只登记公钥和可信指纹。</p>
            </div>
          </div>
          <div className="form-grid">
            <Field label="勘察员编号">
              <input
                value={form.operatorId}
                onChange={(event) => setForm({ ...form, operatorId: event.target.value })}
                required
              />
            </Field>
            <Field label="显示姓名">
              <input
                value={form.displayName}
                onChange={(event) => setForm({ ...form, displayName: event.target.value })}
                required
              />
            </Field>
            <Field label="所属机构">
              <input value={form.organization} readOnly />
            </Field>
            <Field label="勘察员密钥编号">
              <input
                value={form.keyId}
                onChange={(event) => setForm({ ...form, keyId: event.target.value })}
                required
              />
            </Field>
          </div>
        </section>
        <section className="form-section">
          <div className="section-heading">
            <span>3</span>
            <div>
              <h3>签发现场任务</h3>
              <p>任务绑定本案件、勘察员密钥和明确有效期。</p>
            </div>
          </div>
          <div className="form-grid">
            <Field
              label="任务编号"
              hint="直接填写现场任务编号即可；程序会自动生成安全文件名，无需输入 assignment- 前缀。"
            >
              <input
                value={form.assignmentId}
                onChange={(event) => setForm({ ...form, assignmentId: event.target.value })}
                required
              />
            </Field>
            <Field label="授权引用">
              <input value={caseSummary.authorizationReference} readOnly />
            </Field>
            <Field label="生效时间">
              <input
                type="datetime-local"
                value={form.validFrom}
                onChange={(event) => setForm({ ...form, validFrom: event.target.value })}
                required
              />
            </Field>
            <Field label="失效时间">
              <input
                type="datetime-local"
                value={form.validUntil}
                onChange={(event) => setForm({ ...form, validUntil: event.target.value })}
                required
              />
            </Field>
          </div>
          <Field label="目标说明">
            <input
              value={form.targetDescription}
              onChange={(event) =>
                setForm({ ...form, targetDescription: event.target.value })
              }
              required
            />
          </Field>
        </section>
        <section className="form-section">
          <div className="section-heading">
            <span>4</span>
            <div>
              <h3>解锁与保护密钥</h3>
              <p>口令只在本次操作中使用，不写入任务、日志或案件数据库。</p>
            </div>
          </div>
          <Field label="工作站配置签名密钥口令">
            <input
              type="password"
              autoComplete="current-password"
              value={form.workstationPassphrase}
              onChange={(event) =>
                setForm({ ...form, workstationPassphrase: event.target.value })
              }
              required
              minLength={8}
            />
          </Field>
          <div className="form-grid">
            <Field
              label="新勘察员密钥口令"
              hint="至少 8 个字符，并包含大写字母、小写字母、数字和符号。"
            >
              <input
                type="password"
                autoComplete="new-password"
                value={form.operatorPassphrase}
                onChange={(event) =>
                  setForm({ ...form, operatorPassphrase: event.target.value })
                }
                required
                minLength={8}
              />
            </Field>
            <Field label="再次输入勘察员口令">
              <input
                type="password"
                autoComplete="new-password"
                value={form.operatorPassphraseConfirmation}
                onChange={(event) =>
                  setForm({
                    ...form,
                    operatorPassphraseConfirmation: event.target.value,
                  })
                }
                required
                minLength={8}
              />
            </Field>
          </div>
        </section>
        {error ? <div className="inline-alert inline-alert--error">{error}</div> : null}
        <footer className="modal__actions modal__actions--sticky">
          <Button type="button" variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" busy={busy} icon={<HardDriveDownload size={17} />}>
            生成完整取证 U 盘
          </Button>
        </footer>
      </form>
    </Modal>
  );
}

function UpdateUsbSoftwareModal({
  onClose,
  onComplete,
}: {
  onClose: () => void;
  onComplete: (message: string) => void;
}) {
  const [usbRoot, setUsbRoot] = useState("");
  const [inspection, setInspection] = useState<UsbSoftwareInspection | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busyAction, setBusyAction] = useState<"inspect" | "update" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function chooseAndInspect() {
    setError(null);
    setInspection(null);
    setConfirmed(false);
    try {
      const selected = unwrap(await window.wafc.chooseUsbRoot());
      if (!selected) return;
      setUsbRoot(selected);
      setBusyAction("inspect");
      setInspection(
        unwrap(await window.wafc.inspectUsbSoftware({ usbRoot: selected })),
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "无法检查取证 U 盘软件",
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function updateSoftware(event: FormEvent) {
    event.preventDefault();
    if (!inspection || !usbRoot) return;
    if (!confirmed) {
      setError("请先确认 Field Collector 已关闭并保持 U 盘连接稳定");
      return;
    }
    setBusyAction("update");
    setError(null);
    try {
      const result = unwrap(
        await window.wafc.updateUsbSoftware({ usbRoot }),
      );
      onComplete(
        result.status === "already_current"
          ? `该取证 U 盘已经是当前版本 ${result.newReleaseVersion}。`
          : `取证 U 盘软件已从 ${result.previousReleaseVersion} 更新到 ${result.newReleaseVersion}；任务、密钥和证据均已保留。下次采集前，请在浏览器扩展管理页点击一次“重新加载”。${
              result.cleanupPending
                ? "旧程序仍被占用，已保留安全备份；关闭旧 Collector 后可在下次更新时自动恢复清理。"
                : ""
            }`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "取证 U 盘软件更新失败");
    } finally {
      setBusyAction(null);
    }
  }

  const busy = busyAction !== null;
  return (
    <Modal
      title="更新已部署 U 盘软件"
      description="只更新采集程序、独立校验器、浏览器扩展和 Adapter，不重新签发任务或密钥。"
      onClose={onClose}
      closeDisabled={busy}
    >
      <form className="form-stack modal__body" onSubmit={updateSoftware}>
        <section className="form-section">
          <div className="section-heading">
            <span>1</span>
            <div>
              <h3>选择已经部署任务的取证 U 盘</h3>
              <p>程序会验证配置签名、勘察员身份、任务清单和当前软件清单。</p>
            </div>
          </div>
          <div className="path-picker">
            <code>{usbRoot || "尚未选择"}</code>
            <Button
              type="button"
              variant="secondary"
              icon={<Usb size={17} />}
              busy={busyAction === "inspect"}
              disabled={busy}
              onClick={() => void chooseAndInspect()}
            >
              选择并检查
            </Button>
          </div>
        </section>

        {inspection ? (
          <section className="form-section software-update-summary">
            <div className="section-heading">
              <span>2</span>
              <div>
                <h3>确认版本与保留内容</h3>
                <p>只有当前 Workstation 信任身份签发且未被篡改的 U 盘才能更新。</p>
              </div>
            </div>
            <dl>
              <div>
                <dt>勘察员</dt>
                <dd>{inspection.operatorDisplayName}</dd>
              </div>
              <div>
                <dt>签名任务</dt>
                <dd>{inspection.assignmentIds.length} 个</dd>
              </div>
              <div>
                <dt>当前版本</dt>
                <dd>{inspection.currentReleaseVersion}</dd>
              </div>
              <div>
                <dt>可用版本</dt>
                <dd>{inspection.availableReleaseVersion}</dd>
              </div>
            </dl>
            <div
              className={`inline-alert ${
                inspection.updateNeeded
                  ? "inline-alert--info"
                  : "inline-alert--success"
              }`}
            >
              {inspection.updateNeeded
                ? "可以更新。勘察员身份、加密私钥、签名任务、已有 Evidence Bag、交接摘要和诊断记录都会原样保留。"
                : "软件和内置清单已经是当前版本，无需重复更新。"}
            </div>
            {inspection.updateNeeded ? (
              <p className="field__hint">
                扩展文件会一并更新；已加载过该 U 盘扩展的浏览器需要在下次采集前点击一次“重新加载”。
              </p>
            ) : null}
            {inspection.updateNeeded ? (
              <label className="confirmation-row">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                <span>
                  我已关闭此 U 盘中的 Field Collector，并会在更新完成前保持 U 盘连接稳定。
                </span>
              </label>
            ) : null}
          </section>
        ) : null}

        {error ? <div className="inline-alert inline-alert--error">{error}</div> : null}
        <footer className="modal__actions modal__actions--sticky">
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
            {inspection && !inspection.updateNeeded ? "关闭" : "取消"}
          </Button>
          {inspection?.updateNeeded ? (
            <Button
              type="submit"
              busy={busyAction === "update"}
              disabled={!confirmed || busy}
              icon={<RefreshCw size={17} />}
            >
              校验并更新软件
            </Button>
          ) : null}
        </footer>
      </form>
    </Modal>
  );
}

function MetricCard({
  icon,
  label,
  value,
  helper,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  helper: string;
}) {
  return (
    <article className="metric-card">
      <div className="metric-card__icon">{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{helper}</small>
      </div>
    </article>
  );
}

function OverviewPanel({
  caseSummary,
  assignments,
}: {
  caseSummary: CaseSummary;
  assignments: AssignmentSummary[];
}) {
  return (
    <div className="content-stack">
      <section className="metric-grid">
        <MetricCard
          icon={<ArchiveRestore size={21} />}
          label="已归档来源"
          value={compactNumber(caseSummary.sourceCount)}
          helper="每个 Profile/账号独立一包"
        />
        <MetricCard
          icon={<MessageSquareText size={21} />}
          label="聊天会话"
          value={compactNumber(caseSummary.chatCount)}
          helper="跨来源统一浏览"
        />
        <MetricCard
          icon={<Database size={21} />}
          label="结构化消息"
          value={compactNumber(caseSummary.messageCount)}
          helper="已建立 FTS5 检索索引"
        />
        <MetricCard
          icon={<FileCheck2 size={21} />}
          label="已签发任务"
          value={compactNumber(assignments.length)}
          helper="绑定勘察员公钥"
        />
      </section>
      <section className="panel">
        <div className="panel__header">
          <div>
            <h3>案件信息</h3>
            <p>证据正文不会进入全局数据库。</p>
          </div>
          <StatusBadge integrity={caseSummary.integrity} />
        </div>
        <dl className="details-grid">
          <div>
            <dt>案件编号</dt>
            <dd>{caseSummary.caseId}</dd>
          </div>
          <div>
            <dt>授权引用</dt>
            <dd>{caseSummary.authorizationReference}</dd>
          </div>
          <div>
            <dt>来源机构</dt>
            <dd>{caseSummary.organization}</dd>
          </div>
          <div>
            <dt>最后更新</dt>
            <dd>{formatDate(caseSummary.updatedAtUtc)}</dd>
          </div>
        </dl>
        {caseSummary.description ? (
          <p className="case-description">{caseSummary.description}</p>
        ) : null}
      </section>
      <section className="panel">
        <div className="panel__header">
          <div>
            <h3>取证任务与勘察员</h3>
            <p>Evidence Bag 只有匹配这些可信指纹时才能归档。</p>
          </div>
        </div>
        {assignments.length === 0 ? (
          <EmptyState
            icon={<Usb size={25} />}
            title="尚未创建取证 U 盘"
            description="使用右上角“创建取证 U 盘”签发第一个现场任务。"
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>任务</th>
                  <th>勘察员</th>
                  <th>密钥</th>
                  <th>有效期</th>
                </tr>
              </thead>
              <tbody>
                {assignments.map((assignment) => (
                  <tr key={assignment.assignmentId}>
                    <td>
                      <strong>{assignment.assignmentId}</strong>
                      <small>{assignment.bundleId}</small>
                    </td>
                    <td>{assignment.operatorId}</td>
                    <td title={assignment.operatorFingerprint}>
                      {shortFingerprint(assignment.operatorFingerprint)}
                    </td>
                    <td>
                      {formatDate(assignment.validFromUtc)}
                      <small>至 {formatDate(assignment.validUntilUtc)}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}

function ChatExplorer({ caseId }: { caseId: string }) {
  const [chatSearch, setChatSearch] = useState("");
  const delayedSearch = useDebouncedValue(chatSearch);
  const [chats, setChats] = useState<Chat[]>([]);
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageCursor, setMessageCursor] = useState<string | null>(null);
  const [loadingChats, setLoadingChats] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingChats(true);
    window.wafc
      .listChats(caseId, delayedSearch ? { search: delayedSearch } : {})
      .then((result) => {
        if (cancelled) return;
        const page = unwrap(result);
        setChats(page.items);
        setSelectedChat((current) => {
          if (current && page.items.some((chat) => chat.recordId === current.recordId)) {
            return current;
          }
          return page.items[0] ?? null;
        });
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : "聊天列表加载失败"),
      )
      .finally(() => {
        if (!cancelled) setLoadingChats(false);
      });
    return () => {
      cancelled = true;
    };
  }, [caseId, delayedSearch]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedChat) {
      setMessages([]);
      setMessageCursor(null);
      return;
    }
    setLoadingMessages(true);
    window.wafc
      .listMessages(caseId, {
        chatRecordId: selectedChat.recordId,
        direction: "backward",
        limit: 100,
      })
      .then((result) => {
        if (cancelled) return;
        const page = unwrap(result);
        setMessages(page.items);
        setMessageCursor(page.nextCursor);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : "消息加载失败"),
      )
      .finally(() => {
        if (!cancelled) setLoadingMessages(false);
      });
    return () => {
      cancelled = true;
    };
  }, [caseId, selectedChat]);

  async function loadEarlier() {
    if (!selectedChat || !messageCursor) return;
    setLoadingMessages(true);
    try {
      const page = unwrap(
        await window.wafc.listMessages(caseId, {
          chatRecordId: selectedChat.recordId,
          direction: "backward",
          limit: 100,
          cursor: messageCursor,
        }),
      );
      setMessages((current) => [...page.items, ...current]);
      setMessageCursor(page.nextCursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "更早消息加载失败");
    } finally {
      setLoadingMessages(false);
    }
  }

  return (
    <section className="chat-explorer">
      <aside className="chat-list-pane">
        <div className="pane-toolbar">
          <div className="search-field">
            <Search size={17} />
            <input
              aria-label="搜索聊天"
              placeholder="搜索聊天名称"
              value={chatSearch}
              onChange={(event) => setChatSearch(event.target.value)}
            />
          </div>
        </div>
        <div className="chat-list" aria-busy={loadingChats}>
          {loadingChats ? <LoadingRows /> : null}
          {!loadingChats && chats.length === 0 ? (
            <EmptyState
              icon={<MessageSquareText size={24} />}
              title="没有聊天"
              description="请先接收并导入现场 Evidence Bag。"
            />
          ) : null}
          {chats.map((chat) => (
            <button
              type="button"
              key={chat.recordId}
              className={`chat-row ${selectedChat?.recordId === chat.recordId ? "is-selected" : ""}`}
              onClick={() => setSelectedChat(chat)}
            >
              <span className="avatar" aria-hidden="true">
                {chat.kind === "group" ? <UsersRound size={18} /> : <UserRound size={18} />}
              </span>
              <span className="chat-row__body">
                <span className="chat-row__title">
                  <strong>{chat.title}</strong>
                  <time>{formatDate(chat.lastObservedAtUtc)}</time>
                </span>
                <span className="chat-row__preview">
                  {chat.lastMessagePreview || "暂无文本预览"}
                </span>
              </span>
              <span className="chat-row__count">{compactNumber(chat.messageCount)}</span>
            </button>
          ))}
        </div>
      </aside>
      <div className="message-pane">
        {selectedChat ? (
          <>
            <header className="message-pane__header">
              <div className="avatar avatar--large" aria-hidden="true">
                {selectedChat.kind === "group" ? (
                  <UsersRound size={20} />
                ) : (
                  <UserRound size={20} />
                )}
              </div>
              <div>
                <h3>{selectedChat.title}</h3>
                <p>
                  {selectedChat.kind} · {compactNumber(selectedChat.messageCount)} 条消息
                </p>
              </div>
            </header>
            <div className="message-stream" aria-busy={loadingMessages}>
              {messageCursor ? (
                <Button
                  variant="ghost"
                  busy={loadingMessages}
                  onClick={loadEarlier}
                  className="load-earlier"
                >
                  加载更早消息
                </Button>
              ) : null}
              {messages.map((message) => (
                <article
                  key={message.recordId}
                  className={`message ${message.flags.fromMe ? "message--mine" : ""}`}
                >
                  <div className="message__meta">
                    <strong>
                      {message.flags.fromMe
                        ? "本账号"
                        : message.senderDisplayName || "未知发送方"}
                    </strong>
                    <time>{formatDate(message.sentAtUtc)}</time>
                  </div>
                  <div className="message__bubble">
                    {message.flags.revoked ? (
                      <em>此消息已撤回</em>
                    ) : (
                      <p>{message.text || message.caption || `[${message.kind}]`}</p>
                    )}
                    {message.attachmentCount > 0 ? (
                      <span className="message__attachment">
                        <FileCheck2 size={14} /> {message.attachmentCount} 个附件引用
                      </span>
                    ) : null}
                    <span className="message__flags">
                      {message.flags.edited ? "已编辑" : null}
                      {message.flags.forwarded ? "已转发" : null}
                      {message.flags.starred ? "已标星" : null}
                    </span>
                  </div>
                </article>
              ))}
              {!loadingMessages && messages.length === 0 ? (
                <EmptyState
                  icon={<MessageSquareText size={24} />}
                  title="当前会话没有消息"
                  description="完整性页面会说明该来源的采集范围。"
                />
              ) : null}
            </div>
          </>
        ) : (
          <EmptyState
            icon={<MessageSquareText size={28} />}
            title="选择一个聊天"
            description="从左侧列表选择会话后浏览结构化消息。"
          />
        )}
      </div>
      {error ? <div className="floating-error">{error}</div> : null}
    </section>
  );
}

function LoadingRows() {
  return (
    <div className="loading-rows" aria-label="正在加载">
      {[0, 1, 2, 3].map((index) => (
        <span key={index} />
      ))}
    </div>
  );
}

function SearchPanel({ caseId }: { caseId: string }) {
  const [text, setText] = useState("");
  const delayed = useDebouncedValue(text, 350);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!delayed.trim()) {
      setHits([]);
      return;
    }
    setBusy(true);
    setError(null);
    window.wafc
      .searchMessages(caseId, { text: delayed, limit: 100 })
      .then((result) => {
        if (!cancelled) setHits(unwrap(result).items);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "检索失败");
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [caseId, delayed]);

  return (
    <div className="content-stack search-page">
      <section className="panel search-hero">
        <p className="eyebrow">FTS5 TRIGRAM INDEX</p>
        <h2>检索案件消息</h2>
        <p>支持中文连续子串、聊天标题和发送方名称；结果最多显示 100 条。</p>
        <div className="search-field search-field--large">
          {busy ? <LoaderCircle className="spin" size={20} /> : <Search size={20} />}
          <input
            autoFocus
            aria-label="搜索案件消息"
            placeholder="输入关键词，例如：转账、账号、验证码"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
      </section>
      {error ? <div className="inline-alert inline-alert--error">{error}</div> : null}
      {text && !busy && hits.length === 0 ? (
        <EmptyState
          icon={<FileSearch size={25} />}
          title="没有匹配结果"
          description="可以尝试更短的连续关键词或检查完整性范围。"
        />
      ) : null}
      <section className="search-results" aria-live="polite">
        {hits.map((hit) => (
          <article className="search-result" key={hit.message.recordId}>
            <header>
              <span className="avatar" aria-hidden="true">
                <MessageSquareText size={17} />
              </span>
              <div>
                <strong>{hit.chatTitle}</strong>
                <span>
                  {hit.message.senderDisplayName ||
                    (hit.message.flags.fromMe ? "本账号" : "未知发送方")}
                  {" · "}
                  {formatDate(hit.message.sentAtUtc)}
                </span>
              </div>
              <code>{hit.message.kind}</code>
            </header>
            <p>{hit.snippet || hit.message.text || hit.message.caption || "无文本内容"}</p>
            <footer>
              <span>证据记录</span>
              <code>{hit.message.recordId}</code>
              <span>SHA-256</span>
              <code>{shortFingerprint(hit.message.contentSha256)}</code>
            </footer>
          </article>
        ))}
      </section>
    </div>
  );
}

function IntegrityPanel({ caseId }: { caseId: string }) {
  const [integrity, setIntegrity] = useState<IntegritySummary | null>(null);
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([window.wafc.getIntegrity(caseId), window.wafc.listSources(caseId)])
      .then(([integrityResult, sourcesResult]) => {
        if (cancelled) return;
        setIntegrity(unwrap(integrityResult));
        setSources(unwrap(sourcesResult));
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : "完整性信息加载失败"),
      );
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  if (error) return <div className="inline-alert inline-alert--error">{error}</div>;
  if (!integrity) return <LoadingRows />;
  return (
    <div className="content-stack">
      <section className="integrity-banner">
        <div className={`integrity-orb integrity-orb--${integrity.overall}`}>
          {integrity.overall === "verified" ? (
            <ShieldCheck size={30} />
          ) : (
            <CircleAlert size={30} />
          )}
        </div>
        <div>
          <p className="eyebrow">EVIDENCE INTEGRITY</p>
          <h2>
            {integrity.overall === "verified"
              ? "所有来源均通过可信校验"
              : integrity.overall === "empty"
                ? "尚未导入证据来源"
                : "证据有效，但采集范围存在限制"}
          </h2>
          <p>
            {integrity.trustedSourceCount}/{integrity.sourceCount} 个来源已绑定工作站登记的勘察员公钥，
            共 {compactNumber(integrity.totalMessages)} 条消息。
          </p>
        </div>
      </section>
      <section className="panel">
        <div className="panel__header">
          <div>
            <h3>来源校验明细</h3>
            <p>每个 Profile 与 WhatsApp 账号独立封存和签名。</p>
          </div>
        </div>
        {sources.length === 0 ? (
          <EmptyState
            icon={<ArchiveRestore size={24} />}
            title="暂无来源"
            description="插回取证 U 盘后使用“接收取证 U 盘”。"
          />
        ) : (
          <div className="source-grid">
            {sources.map((source) => (
              <article className="source-card" key={source.sourceId}>
                <header>
                  <ShieldCheck size={18} />
                  <strong>{source.assignmentId}</strong>
                  <span>{source.localSnapshot}</span>
                </header>
                <dl>
                  <div>
                    <dt>Evidence ID</dt>
                    <dd>{source.evidenceId}</dd>
                  </div>
                  <div>
                    <dt>勘察员</dt>
                    <dd>{source.operatorId}</dd>
                  </div>
                  <div>
                    <dt>签名指纹</dt>
                    <dd title={source.signerFingerprint}>
                      {shortFingerprint(source.signerFingerprint)}
                    </dd>
                  </div>
                  <div>
                    <dt>Manifest root</dt>
                    <dd title={source.manifestRootSha256}>
                      {shortFingerprint(source.manifestRootSha256)}
                    </dd>
                  </div>
                  <div>
                    <dt>历史范围</dt>
                    <dd>{source.historyScope}</dd>
                  </div>
                  <div>
                    <dt>媒体范围</dt>
                    <dd>{source.mediaScope}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        )}
      </section>
      <section className="panel limitations">
        <div className="panel__header">
          <div>
            <h3>范围与限制</h3>
            <p>这些限制会在后续分析与报告中保留。</p>
          </div>
        </div>
        <ul>
          {integrity.limitations.map((limitation) => (
            <li key={limitation}>
              <CircleAlert size={17} />
              <span>{limitation}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function CaseWorkspace({
  caseSummary,
  onBack,
  onRefresh,
  onUpdateUsb,
  notify,
}: {
  caseSummary: CaseSummary;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onUpdateUsb: () => void;
  notify: (notice: Notice) => void;
}) {
  const [tab, setTab] = useState<CaseTab>("overview");
  const [assignments, setAssignments] = useState<AssignmentSummary[]>([]);
  const [showProvision, setShowProvision] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const loadAssignments = useCallback(async () => {
    try {
      setAssignments(unwrap(await window.wafc.listAssignments(caseSummary.caseId)));
    } catch (caught) {
      notify({
        kind: "error",
        message: caught instanceof Error ? caught.message : "任务列表加载失败",
      });
    }
  }, [caseSummary.caseId, notify]);

  useEffect(() => {
    void loadAssignments();
  }, [loadAssignments]);

  async function intakeUsb() {
    setBusyAction("intake");
    try {
      const root = unwrap(await window.wafc.chooseUsbRoot());
      if (!root) return;
      const result = unwrap(await window.wafc.intakeUsb(caseSummary.caseId, root));
      await onRefresh();
      notify({
        kind: result.skipped.length > 0 ? "info" : "success",
        message: `已接收 ${result.imported.length} 个证据包，拒绝或跳过 ${result.skipped.length} 个。`,
      });
    } catch (caught) {
      notify({
        kind: "error",
        message: caught instanceof Error ? caught.message : "U 盘接收失败",
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function importBag() {
    setBusyAction("import");
    try {
      const bag = unwrap(await window.wafc.chooseEvidenceBag());
      if (!bag) return;
      const result = unwrap(
        await window.wafc.importEvidence(caseSummary.caseId, bag),
      );
      await onRefresh();
      notify({
        kind: "success",
        message:
          result.status === "already_imported"
            ? "该 Evidence Bag 已归档，幂等检查未产生重复数据。"
            : `已归档 ${result.chatCount} 个聊天、${result.messageCount} 条消息。`,
      });
    } catch (caught) {
      notify({
        kind: "error",
        message: caught instanceof Error ? caught.message : "Evidence Bag 导入失败",
      });
    } finally {
      setBusyAction(null);
    }
  }

  const tabs: Array<{ id: CaseTab; label: string; icon: ReactNode }> = [
    { id: "overview", label: "案件概览", icon: <BriefcaseBusiness size={17} /> },
    { id: "chats", label: "聊天记录", icon: <MessageSquareText size={17} /> },
    { id: "search", label: "全文检索", icon: <Search size={17} /> },
    { id: "integrity", label: "完整性", icon: <ShieldCheck size={17} /> },
  ];

  return (
    <main className="case-workspace">
      <header className="case-header">
        <div className="case-header__identity">
          <button type="button" className="icon-button" onClick={onBack} aria-label="返回案件列表">
            <ArrowLeft size={20} />
          </button>
          <div>
            <div className="case-header__title">
              <h1>{caseSummary.name}</h1>
              <StatusBadge integrity={caseSummary.integrity} />
            </div>
            <p>
              {caseSummary.caseId} · {caseSummary.authorizationReference}
            </p>
          </div>
        </div>
        <div className="case-header__actions">
          <Button
            variant="secondary"
            icon={<RefreshCw size={17} />}
            onClick={onUpdateUsb}
          >
            更新 U 盘
          </Button>
          <Button
            variant="secondary"
            icon={<FolderInput size={17} />}
            busy={busyAction === "import"}
            onClick={importBag}
          >
            导入证据包
          </Button>
          <Button
            variant="secondary"
            icon={<ArchiveRestore size={17} />}
            busy={busyAction === "intake"}
            onClick={intakeUsb}
          >
            接收取证 U 盘
          </Button>
          <Button icon={<Usb size={17} />} onClick={() => setShowProvision(true)}>
            创建取证 U 盘
          </Button>
        </div>
      </header>
      <nav className="case-tabs" aria-label="案件功能">
        {tabs.map((item) => (
          <button
            type="button"
            key={item.id}
            className={tab === item.id ? "is-active" : ""}
            onClick={() => setTab(item.id)}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </nav>
      <div className={`case-content ${tab === "chats" ? "case-content--full" : ""}`}>
        {tab === "overview" ? (
          <OverviewPanel caseSummary={caseSummary} assignments={assignments} />
        ) : null}
        {tab === "chats" ? <ChatExplorer caseId={caseSummary.caseId} /> : null}
        {tab === "search" ? <SearchPanel caseId={caseSummary.caseId} /> : null}
        {tab === "integrity" ? <IntegrityPanel caseId={caseSummary.caseId} /> : null}
      </div>
      {showProvision ? (
        <ProvisionUsbModal
          caseSummary={caseSummary}
          onClose={() => setShowProvision(false)}
          onComplete={(message) => {
            setShowProvision(false);
            void loadAssignments();
            notify({ kind: "success", message });
          }}
        />
      ) : null}
    </main>
  );
}

function CaseList({
  cases,
  onSelect,
  onCreate,
  onIntakeUsb,
  onUpdateUsb,
  intakeBusy,
}: {
  cases: CaseSummary[];
  onSelect: (caseSummary: CaseSummary) => void;
  onCreate: () => void;
  onIntakeUsb: () => void;
  onUpdateUsb: () => void;
  intakeBusy: boolean;
}) {
  return (
    <main className="page-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">CASE MANAGEMENT</p>
          <h1>案件工作区</h1>
          <p>创建案件、签发取证 U 盘并归档经可信校验的现场证据。</p>
        </div>
        <div className="page-header__actions">
          <Button
            variant="secondary"
            icon={<RefreshCw size={17} />}
            onClick={onUpdateUsb}
          >
            更新取证 U 盘
          </Button>
          <Button
            variant="secondary"
            icon={<Usb size={17} />}
            busy={intakeBusy}
            onClick={onIntakeUsb}
          >
            自动接收取证 U 盘
          </Button>
          <Button icon={<Plus size={17} />} onClick={onCreate}>
            创建案件
          </Button>
        </div>
      </header>
      {cases.length === 0 ? (
        <section className="panel empty-panel">
          <EmptyState
            icon={<BriefcaseBusiness size={30} />}
            title="从第一个案件开始"
            description="创建案件后，可以为勘察员生成专属取证 U 盘。"
          />
          <Button icon={<Plus size={17} />} onClick={onCreate}>
            创建第一个案件
          </Button>
        </section>
      ) : (
        <section className="case-card-grid">
          {cases.map((caseSummary) => (
            <button
              type="button"
              className="case-card"
              key={caseSummary.caseId}
              onClick={() => onSelect(caseSummary)}
            >
              <header>
                <div className="case-card__icon">
                  <BriefcaseBusiness size={20} />
                </div>
                <StatusBadge integrity={caseSummary.integrity} />
              </header>
              <div>
                <span className="case-card__id">{caseSummary.caseId}</span>
                <h2>{caseSummary.name}</h2>
                <p>{caseSummary.description || caseSummary.authorizationReference}</p>
              </div>
              <dl>
                <div>
                  <dt>来源</dt>
                  <dd>{compactNumber(caseSummary.sourceCount)}</dd>
                </div>
                <div>
                  <dt>聊天</dt>
                  <dd>{compactNumber(caseSummary.chatCount)}</dd>
                </div>
                <div>
                  <dt>消息</dt>
                  <dd>{compactNumber(caseSummary.messageCount)}</dd>
                </div>
              </dl>
              <footer>
                <span>更新于 {formatDate(caseSummary.updatedAtUtc)}</span>
                <ChevronRight size={18} />
              </footer>
            </button>
          ))}
        </section>
      )}
    </main>
  );
}

export function App() {
  const [status, setStatus] = useState<WorkstationStatus | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [showCreateCase, setShowCreateCase] = useState(false);
  const [showUpdateUsb, setShowUpdateUsb] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [intakeBusy, setIntakeBusy] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const next = unwrap(await window.wafc.status());
      setStatus(next);
      setFatalError(null);
    } catch (caught) {
      setFatalError(caught instanceof Error ? caught.message : "工作站启动失败");
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 6_000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const intakeUsbAutomatically = useCallback(async () => {
    setIntakeBusy(true);
    try {
      const root = unwrap(await window.wafc.chooseUsbRoot());
      if (!root) return;
      const result = unwrap(await window.wafc.intakeUsbAutomatically(root));
      await loadStatus();
      const imported = result.imported.filter(
        (item) => item.status === "imported",
      ).length;
      const existing = result.imported.length - imported;
      setNotice({
        kind: result.skipped.length > 0 ? "info" : "success",
        message: `U 盘接收完成：新归档 ${imported} 包，已存在 ${existing} 包，拒绝 ${result.skipped.length} 包。`,
      });
    } catch (caught) {
      setNotice({
        kind: "error",
        message: caught instanceof Error ? caught.message : "U 盘接收失败",
      });
    } finally {
      setIntakeBusy(false);
    }
  }, [loadStatus]);

  const selectedCase = useMemo(
    () => status?.cases.find((item) => item.caseId === selectedCaseId) ?? null,
    [selectedCaseId, status?.cases],
  );

  if (fatalError) {
    return (
      <main className="fatal-screen">
        <CircleAlert size={36} />
        <h1>Analysis Workstation 无法启动</h1>
        <p>{fatalError}</p>
        <Button onClick={loadStatus}>重新检查</Button>
      </main>
    );
  }
  if (!status) {
    return (
      <main className="splash-screen">
        <LoaderCircle className="spin" size={34} />
        <p>正在验证工作站组件…</p>
      </main>
    );
  }
  if (!status.initialized) {
    return <Onboarding onComplete={setStatus} />;
  }

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="app-brand">
          <div className="brand-mark brand-mark--small">
            <ShieldCheck size={22} />
          </div>
          <div>
            <strong>Analysis Workstation</strong>
            <span>WhatsApp 快速取证</span>
          </div>
        </div>
        <nav>
          <button
            type="button"
            className={!selectedCase ? "is-active" : ""}
            onClick={() => setSelectedCaseId(null)}
          >
            <BriefcaseBusiness size={19} />
            <span>案件</span>
            <small>{status.cases.length}</small>
          </button>
          <button type="button" disabled title="v0.2 计划功能">
            <ListFilter size={19} />
            <span>分析任务</span>
            <small>后续</small>
          </button>
        </nav>
        <footer className="sidebar-profile">
          <LockKeyhole size={18} />
          <div>
            <strong>{status.profile?.workstationId}</strong>
            <span title={status.profile?.fingerprintSha256}>
              {shortFingerprint(status.profile?.fingerprintSha256 ?? "")}
            </span>
          </div>
          <ChevronDown size={16} />
        </footer>
      </aside>
      {selectedCase ? (
        <CaseWorkspace
          caseSummary={selectedCase}
          onBack={() => setSelectedCaseId(null)}
          onRefresh={loadStatus}
          onUpdateUsb={() => setShowUpdateUsb(true)}
          notify={setNotice}
        />
      ) : (
        <CaseList
          cases={status.cases}
          onSelect={(caseSummary) => setSelectedCaseId(caseSummary.caseId)}
          onCreate={() => setShowCreateCase(true)}
          onIntakeUsb={() => void intakeUsbAutomatically()}
          onUpdateUsb={() => setShowUpdateUsb(true)}
          intakeBusy={intakeBusy}
        />
      )}
      {showCreateCase ? (
        <CreateCaseModal
          onClose={() => setShowCreateCase(false)}
          onCreated={(created) => {
            setShowCreateCase(false);
            void loadStatus().then(() => setSelectedCaseId(created.caseId));
            setNotice({ kind: "success", message: `案件 ${created.caseId} 已创建。` });
          }}
        />
      ) : null}
      {showUpdateUsb ? (
        <UpdateUsbSoftwareModal
          onClose={() => setShowUpdateUsb(false)}
          onComplete={(message) => {
            setShowUpdateUsb(false);
            setNotice({ kind: "success", message });
          }}
        />
      ) : null}
      {notice ? (
        <div className={`toast toast--${notice.kind}`} role="status">
          {notice.kind === "success" ? (
            <CheckCircle2 size={18} />
          ) : notice.kind === "error" ? (
            <CircleAlert size={18} />
          ) : (
            <FileSearch size={18} />
          )}
          <span>{notice.message}</span>
          <button type="button" aria-label="关闭通知" onClick={() => setNotice(null)}>
            <X size={16} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
