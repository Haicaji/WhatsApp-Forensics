import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  FolderOpen,
  MagnifyingGlass,
  Plus,
} from "@phosphor-icons/react";

import type { CaseSummary } from "@wafc/domain";

import { EmptyState, InlineError, LoadingRows } from "../components/Feedback";
import { Modal } from "../components/Modal";
import {
  errorMessage,
  formatDateTime,
  unwrap,
} from "../lib/api";

type CaseManagementPageProps = {
  onEnterCase: (summary: CaseSummary) => Promise<void>;
};

export function CaseManagementPage({
  onEnterCase,
}: CaseManagementPageProps): React.JSX.Element {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [opening, setOpening] = useState(false);

  const loadCases = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const loaded = unwrap(await window.workstation.cases.list());
      setCases(loaded);
      setSelectedCaseId((current) =>
        current !== null && loaded.some((item) => item.caseId === current)
          ? current
          : loaded[0]?.caseId ?? null,
      );
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCases();
  }, [loadCases]);

  const filteredCases = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("zh-CN");
    if (term === "") return cases;
    return cases.filter((item) =>
      item.name.toLocaleLowerCase("zh-CN").includes(term),
    );
  }, [cases, search]);

  const selected = cases.find((item) => item.caseId === selectedCaseId) ?? null;

  const openCase = async (summary: CaseSummary): Promise<void> => {
    if (opening) return;
    setOpening(true);
    setError(null);
    try {
      await onEnterCase(summary);
    } catch (openError) {
      setError(errorMessage(openError));
    } finally {
      setOpening(false);
    }
  };

  return (
    <section className="case-management" aria-label="案件管理">
      <aside className="case-browser">
        <div className="case-browser__toolbar">
          <label className="search-field">
            <MagnifyingGlass size={18} aria-hidden="true" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索案件名称"
              aria-label="搜索案件"
            />
          </label>
          <button type="button" className="primary-button" onClick={() => setCreateOpen(true)}>
            <Plus size={17} weight="bold" />
            新建案件
          </button>
        </div>
        {error === null ? null : <div className="case-browser__error"><InlineError message={error} /></div>}
        <div className="case-list" role="listbox" aria-label="案件列表">
          {loading ? (
            <LoadingRows count={5} />
          ) : filteredCases.length === 0 ? (
            <EmptyState
              title={cases.length === 0 ? "还没有案件" : "没有匹配案件"}
              description={cases.length === 0
                ? "新建案件后会自动进入案件工作区。"
                : "请调整搜索关键词后重试。"}
            />
          ) : (
            filteredCases.map((item) => (
              <button
                type="button"
                key={item.caseId}
                className={`case-row${item.caseId === selectedCaseId ? " case-row--selected" : ""}`}
                role="option"
                aria-selected={item.caseId === selectedCaseId}
                onClick={() => setSelectedCaseId(item.caseId)}
                onDoubleClick={() => void openCase(item)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void openCase(item);
                }}
              >
                <span className="case-row__icon"><FolderOpen size={21} weight="duotone" /></span>
                <span className="case-row__content">
                  <strong>{item.name}</strong>
                  <span>{item.sourceCount} 个检材，{item.messageCount} 条消息</span>
                </span>
                <ArrowRight size={17} className="case-row__arrow" aria-hidden="true" />
              </button>
            ))
          )}
        </div>
      </aside>
      <div className="case-preview">
        {selected === null ? (
          <EmptyState
            title="选择一个案件"
            description="单击案件查看摘要，双击或按 Enter 进入。"
          />
        ) : (
          <CasePreview summary={selected} />
        )}
      </div>
      {createOpen ? (
        <CreateCaseModal
          onClose={() => setCreateOpen(false)}
          onCreated={async (summary) => {
            setCreateOpen(false);
            setCases((current) => [summary, ...current]);
            setSelectedCaseId(summary.caseId);
            await openCase(summary);
          }}
        />
      ) : null}
    </section>
  );
}

function CasePreview({
  summary,
}: {
  summary: CaseSummary;
}): React.JSX.Element {
  return (
    <div className="case-preview__content">
      <div className="case-preview__heading">
        <h1>{summary.name}</h1>
      </div>
      <dl className="case-details">
        <div>
          <dt>创建时间</dt>
          <dd>{formatDateTime(summary.createdAtUtc)}</dd>
        </div>
        <div>
          <dt>案件编号</dt>
          <dd className="monospace">{summary.caseId}</dd>
        </div>
        <div className="case-details__wide">
          <dt>保存位置</dt>
          <dd title={summary.path}>{summary.path}</dd>
        </div>
      </dl>
    </div>
  );
}

function CreateCaseModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (summary: CaseSummary) => Promise<void>;
}): React.JSX.Element {
  const [name, setName] = useState("");
  const [parentDirectory, setParentDirectory] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.workstation.cases.settings().then((result) => {
      if (result.ok) setParentDirectory(result.value.defaultCasesDirectory);
    });
  }, []);

  const chooseDirectory = async (): Promise<void> => {
    setChoosing(true);
    setError(null);
    try {
      const selected = unwrap(await window.workstation.cases.chooseParentDirectory());
      if (selected !== null) setParentDirectory(selected);
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
      const created = unwrap(await window.workstation.cases.create({ name, parentDirectory }));
      await onCreated(created);
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="新建案件"
      onClose={onClose}
    >
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span>案件名称</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={200}
          />
        </label>
        <label className="field">
          <span>案件保存位置</span>
          <div className="path-picker">
            <input
              value={parentDirectory}
              onChange={(event) => setParentDirectory(event.target.value)}
              placeholder="选择案件父目录"
            />
            <button type="button" className="secondary-button" disabled={choosing} onClick={() => void chooseDirectory()}>
              <FolderOpen size={17} />
              {choosing ? "正在选择" : "选择"}
            </button>
          </div>
        </label>
        {error === null ? null : <InlineError message={error} />}
        <div className="modal__actions">
          <button
            type="submit"
            className="primary-button"
            disabled={submitting || name.trim() === "" || parentDirectory.trim() === ""}
          >
            {submitting ? "正在创建" : "创建并进入"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
