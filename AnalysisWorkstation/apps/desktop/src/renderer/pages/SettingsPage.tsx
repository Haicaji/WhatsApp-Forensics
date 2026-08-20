import { useEffect, useState } from "react";
import { Database, FolderOpen, HardDrive } from "@phosphor-icons/react";

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
          <p className="page-kicker">本机设置</p>
          <h1>数据位置</h1>
          <p>本阶段只显示便携数据目录和默认案件目录。</p>
        </div>
      </header>
      {error === null ? null : <InlineError message={error} />}
      {settings === null && error === null ? (
        <div className="settings-loading"><LoadingRows count={3} /></div>
      ) : settings === null ? null : (
        <div className="settings-list">
          <SettingRow
            icon={<HardDrive size={23} weight="duotone" />}
            label="软件数据目录"
            description="Catalog、Electron 运行数据和日志都保存在这里。"
            path={settings.dataDirectory}
            onOpen={() => void window.workstation.cases.openFolder({ target: "data" })}
          />
          <SettingRow
            icon={<FolderOpen size={23} weight="duotone" />}
            label="默认案件目录"
            description="新建案件时默认选择的位置，仍可在创建框中改为其他父目录。"
            path={settings.defaultCasesDirectory}
            onOpen={() => void window.workstation.cases.openFolder({ target: "defaultCases" })}
          />
          <SettingRow
            icon={<Database size={23} weight="duotone" />}
            label="案件目录索引"
            description="只保存案件入口与摘要，不保存聊天原文。"
            path={settings.catalogPath}
          />
        </div>
      )}
      <div className="notice-panel settings-notice">
        <strong>便携存储约束</strong>
        <p>应用不会把 WAFC Analysis Workstation 数据写入用户的 AppData Roaming。程序所在目录必须可写。</p>
      </div>
    </section>
  );
}

function SettingRow({
  icon,
  label,
  description,
  path,
  onOpen,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  path: string;
  onOpen?: () => void;
}): React.JSX.Element {
  return (
    <div className="setting-row">
      <span className="setting-row__icon">{icon}</span>
      <div className="setting-row__content">
        <strong>{label}</strong>
        <p>{description}</p>
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
