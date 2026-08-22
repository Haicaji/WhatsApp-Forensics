import { useCallback, useEffect, useState } from "react";
import {
  ArrowDown,
  FolderOpen,
  Plus,
  Prohibit,
  Tray,
  Usb,
} from "@phosphor-icons/react";

import type {
  CaseSummary,
  ReceiveResult,
  TaskSummary,
} from "@wafc/domain";

import { EmptyState, InlineError, LoadingRows } from "../components/Feedback";
import { Modal } from "../components/Modal";
import { errorMessage, formatDateTime, unwrap } from "../lib/api";

export function TaskPage({ activeCase }: { activeCase: CaseSummary }): React.JSX.Element {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [disableTarget, setDisableTarget] = useState<TaskSummary | null>(null);
  const [receiveResults, setReceiveResults] = useState<ReceiveResult[] | null>(null);
  const [receiving, setReceiving] = useState(false);

  const loadTasks = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setTasks(unwrap(await window.workstation.tasks.list(activeCase.caseId)));
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [activeCase.caseId]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  const receive = async (): Promise<void> => {
    setReceiving(true);
    setError(null);
    try {
      const selected = unwrap(await window.workstation.results.chooseSource());
      if (selected === null) return;
      const results = unwrap(await window.workstation.results.receive({
        caseId: activeCase.caseId,
        selectedPath: selected,
      }));
      setReceiveResults(results);
      await loadTasks();
    } catch (receiveError) {
      setError(errorMessage(receiveError));
    } finally {
      setReceiving(false);
    }
  };

  const disable = async (task: TaskSummary): Promise<void> => {
    setError(null);
    try {
      const disabled = unwrap(
        await window.workstation.tasks.disable(activeCase.caseId, task.taskId),
      );
      setTasks((current) => current.map((item) =>
        item.taskId === disabled.taskId ? disabled : item,
      ));
      setDisableTarget(null);
    } catch (disableError) {
      setError(errorMessage(disableError));
    }
  };

  return (
    <section className="content-page task-page">
      {error === null ? null : <InlineError message={error} />}
      <div className="task-list-panel">
        <div className="task-list-heading">
          <h2>已下发任务</h2>
          <div className="page-header__actions">
            <button type="button" className="secondary-button" disabled={receiving} onClick={() => void receive()}>
              <ArrowDown size={18} weight="bold" />
              {receiving ? "正在接收" : "接收结果"}
            </button>
            <button type="button" className="primary-button" onClick={() => setAssignOpen(true)}>
              <Plus size={18} weight="bold" />
              分配任务
            </button>
          </div>
        </div>
        <div className="task-table-header" aria-hidden="true">
          <span>任务</span>
          <span>下发位置</span>
          <span>创建时间</span>
          <span>状态与回传</span>
          <span>操作</span>
        </div>
        <div className="task-list">
          {loading ? (
            <LoadingRows count={4} />
          ) : tasks.length === 0 ? (
            <EmptyState title="还没有下发任务" />
          ) : (
            tasks.map((task) => (
              <article className="task-row" key={task.taskId}>
                <div className="task-row__identity">
                  <span className="task-row__icon"><Usb size={22} weight="duotone" /></span>
                  <div>
                    <strong>{task.taskName}</strong>
                    <small className="monospace">{task.taskId}</small>
                  </div>
                </div>
                <div className="task-row__path" title={task.collectorDirectory}>
                  <span>{task.collectorDirectory}</span>
                </div>
                <time>{formatDateTime(task.createdAtUtc)}</time>
                <div className="task-row__status">
                  <span className={`status-label status-label--${task.status}`}>
                    {task.status === "active" ? "启用" : "已停用"}
                  </span>
                  <small>已接收 {task.receivedCount} 个检材</small>
                </div>
                <div className="task-row__actions">
                  <button
                    type="button"
                    className="icon-button icon-button--danger"
                    aria-label={`停用任务：${task.taskName}`}
                    title="停用任务"
                    disabled={task.status === "disabled"}
                    onClick={() => setDisableTarget(task)}
                  >
                    <Prohibit size={18} />
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
      </div>
      {assignOpen ? (
        <AssignTaskModal
          activeCase={activeCase}
          onClose={() => setAssignOpen(false)}
          onAssigned={(task) => {
            setTasks((current) => [task, ...current]);
            setAssignOpen(false);
          }}
        />
      ) : null}
      {disableTarget === null ? null : (
        <Modal
          title="停用任务"
          onClose={() => setDisableTarget(null)}
          width="small"
        >
          <div className="modal__actions modal__actions--standalone">
            <button type="button" className="danger-button" onClick={() => void disable(disableTarget)}>确认停用</button>
          </div>
        </Modal>
      )}
      {receiveResults === null ? null : (
        <ReceiveResultsModal results={receiveResults} onClose={() => setReceiveResults(null)} />
      )}
    </section>
  );
}

function AssignTaskModal({
  activeCase,
  onClose,
  onAssigned,
}: {
  activeCase: CaseSummary;
  onClose: () => void;
  onAssigned: (task: TaskSummary) => void;
}): React.JSX.Element {
  const [taskName, setTaskName] = useState("");
  const [usbRoot, setUsbRoot] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chooseUsb = async (): Promise<void> => {
    setChoosing(true);
    setError(null);
    try {
      const selected = unwrap(await window.workstation.tasks.chooseUsbRoot());
      if (selected !== null) setUsbRoot(selected);
    } catch (chooseError) {
      setError(errorMessage(chooseError));
    } finally {
      setChoosing(false);
    }
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const task = unwrap(await window.workstation.tasks.assign({
        caseId: activeCase.caseId,
        taskName,
        usbRoot,
      }));
      onAssigned(task);
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="分配任务"
      onClose={onClose}
    >
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span>任务名称</span>
          <input
            autoFocus
            value={taskName}
            maxLength={200}
            onChange={(event) => setTaskName(event.target.value)}
          />
        </label>
        <label className="field">
          <span>U 盘根目录</span>
          <div className="path-picker">
            <input
              value={usbRoot}
              onChange={(event) => setUsbRoot(event.target.value)}
            />
            <button type="button" className="secondary-button" disabled={choosing} onClick={() => void chooseUsb()}>
              <FolderOpen size={17} />
              {choosing ? "正在选择" : "选择"}
            </button>
          </div>
        </label>
        {error === null ? null : <InlineError message={error} />}
        <div className="modal__actions">
          <button type="button" className="ghost-button" disabled={submitting} onClick={onClose}>取消</button>
          <button
            type="submit"
            className="primary-button"
            disabled={submitting || taskName.trim() === "" || usbRoot.trim() === ""}
          >
            {submitting ? "正在写入" : "下发到 U 盘"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ReceiveResultsModal({
  results,
  onClose,
}: {
  results: ReceiveResult[];
  onClose: () => void;
}): React.JSX.Element {
  const accepted = results.filter((item) => item.accepted).length;
  const rejected = results.length - accepted;
  return (
    <Modal
      title="接收结果"
      description={`已处理 ${results.length} 个 session，接收 ${accepted} 个，拒绝 ${rejected} 个。`}
      onClose={onClose}
      width="large"
    >
      <div className="receive-result-list">
        {results.map((result) => (
          <div
            className={`receive-result-row receive-result-row--${result.accepted ? "accepted" : "rejected"}`}
            key={result.sessionPath}
          >
            <span className="receive-result-row__icon">
              {result.accepted ? <Tray size={20} weight="duotone" /> : <Prohibit size={20} />}
            </span>
            <div>
              <strong>{result.source?.specimenName ?? "未接收的 session"}</strong>
              <p>{result.userMessage}</p>
              <small title={result.sessionPath}>{result.sessionPath}</small>
            </div>
            <span className={`status-label status-label--${result.accepted ? "active" : "disabled"}`}>
              {result.deduplicated ? "已存在" : result.accepted ? "已接收" : "已拒绝"}
            </span>
          </div>
        ))}
      </div>
      <div className="modal__actions">
        <button type="button" className="primary-button" onClick={onClose}>完成</button>
      </div>
    </Modal>
  );
}
