import {
  ChatCircleDots,
  GearSix,
  ShieldCheck,
  Tray,
} from "@phosphor-icons/react";

export type CaseSection = "tasks" | "chats";

type NavigationRailProps = {
  caseOpen: boolean;
  activeSection: CaseSection;
  settingsActive: boolean;
  onHome: () => void;
  onSection: (section: CaseSection) => void;
  onSettings: () => void;
};

export function NavigationRail({
  caseOpen,
  activeSection,
  settingsActive,
  onHome,
  onSection,
  onSettings,
}: NavigationRailProps): React.JSX.Element {
  return (
    <nav className="navigation-rail" aria-label="主要功能">
      <button
        type="button"
        className="navigation-rail__logo"
        aria-label="返回案件管理"
        title="案件管理"
        onClick={onHome}
      >
        <ShieldCheck size={31} weight="fill" />
      </button>
      {caseOpen ? (
        <div className="navigation-rail__primary">
          <span className="navigation-rail__separator" aria-hidden="true" />
          <RailButton
            label="任务"
            active={!settingsActive && activeSection === "tasks"}
            onClick={() => onSection("tasks")}
          >
            <Tray size={24} weight={activeSection === "tasks" ? "fill" : "regular"} />
          </RailButton>
          <span className="navigation-rail__separator" aria-hidden="true" />
          <RailButton
            label="聊天"
            active={!settingsActive && activeSection === "chats"}
            onClick={() => onSection("chats")}
          >
            <ChatCircleDots
              size={24}
              weight={activeSection === "chats" ? "fill" : "regular"}
            />
          </RailButton>
        </div>
      ) : <div className="navigation-rail__primary" />}
      <RailButton label="设置" showLabel={false} active={settingsActive} onClick={onSettings}>
        <GearSix size={23} weight={settingsActive ? "fill" : "regular"} />
      </RailButton>
    </nav>
  );
}

type RailButtonProps = {
  label: string;
  showLabel?: boolean;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
};

function RailButton({
  label,
  showLabel = true,
  active,
  onClick,
  children,
}: RailButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={`rail-button${active ? " rail-button--active" : ""}`}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      title={label}
      onClick={onClick}
    >
      {children}
      {showLabel ? <span className="rail-button__label">{label}</span> : null}
    </button>
  );
}
