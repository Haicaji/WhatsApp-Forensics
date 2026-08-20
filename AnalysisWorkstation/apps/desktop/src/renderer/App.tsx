import { useCallback, useState } from "react";

import type { CaseSummary } from "@wafc/domain";

import { NavigationRail, type CaseSection } from "./components/NavigationRail";
import { TitleBar } from "./components/TitleBar";
import { CaseManagementPage } from "./pages/CaseManagementPage";
import { ChatPage } from "./pages/ChatPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TaskPage } from "./pages/TaskPage";
import { unwrap } from "./lib/api";

type Route = "cases" | "case" | "settings";

export function App(): React.JSX.Element {
  const [route, setRoute] = useState<Route>("cases");
  const [activeCase, setActiveCase] = useState<CaseSummary | null>(null);
  const [caseSection, setCaseSection] = useState<CaseSection>("tasks");

  const enterCase = useCallback(async (summary: CaseSummary): Promise<void> => {
    const opened = unwrap(await window.workstation.cases.open(summary.caseId));
    setActiveCase(opened);
    setCaseSection("tasks");
    setRoute("case");
  }, []);

  const goHome = useCallback((): void => {
    setRoute("cases");
    setActiveCase(null);
  }, []);

  const chooseSection = useCallback((section: CaseSection): void => {
    if (activeCase === null) return;
    setCaseSection(section);
    setRoute("case");
  }, [activeCase]);

  return (
    <div className="app-root">
      <TitleBar />
      <div className="app-shell">
        <NavigationRail
          caseOpen={activeCase !== null}
          activeSection={caseSection}
          settingsActive={route === "settings"}
          onHome={goHome}
          onSection={chooseSection}
          onSettings={() => setRoute("settings")}
        />
        <main className="workspace">
          {route === "cases" ? (
            <CaseManagementPage onEnterCase={enterCase} />
          ) : route === "settings" ? (
            <SettingsPage />
          ) : activeCase === null ? (
            <CaseManagementPage onEnterCase={enterCase} />
          ) : caseSection === "tasks" ? (
            <TaskPage activeCase={activeCase} />
          ) : (
            <ChatPage activeCase={activeCase} />
          )}
        </main>
      </div>
    </div>
  );
}
