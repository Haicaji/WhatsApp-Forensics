import { useEffect, useState } from "react";
import { FolderOpen } from "@phosphor-icons/react";

import type { SettingsInfo } from "@wafc/domain";

import { InlineError, LoadingRows } from "../components/Feedback";
import { errorMessage, unwrap } from "../lib/api";

export function SettingsPage(): React.JSX.Element {
  const [settings, setSettings] = useState<SettingsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.workstation.cases.settings().then((result) => {
      try {
        setSettings(unwrap(result));
      } catch (loadError) {
        setError(errorMessage(loadError));
      }
    });
  }, []);

  return (
    <section className="content-page settings-page">
      <header className="page-header">
        <div>
          <h1>设置</h1>
        </div>
      </header>
      {error === null ? null : <InlineError message={error} />}
      {settings === null && error === null ? (
        <div className="settings-loading"><LoadingRows count={1} /></div>
      ) : settings === null ? null : (
        <div className="settings-list">
          <SettingRow
            label="数据目录"
            path={settings.dataDirectory}
            onOpen={() => void window.workstation.cases.openFolder({ target: "data" })}
          />
        </div>
      )}
    </section>
  );
}

function SettingRow({
  label,
  path,
  onOpen,
}: {
  label: string;
  path: string;
  onOpen?: () => void;
}): React.JSX.Element {
  return (
    <div className="setting-row">
      <div className="setting-row__content">
        <strong>{label}</strong>
        <code title={path}>{path}</code>
      </div>
      {onOpen === undefined ? null : (
        <button type="button" className="secondary-button" onClick={onOpen}>
          <FolderOpen size={17} />
          打开目录
        </button>
      )}
    </div>
  );
}
