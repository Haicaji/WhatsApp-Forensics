import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "@phosphor-icons/react";

export function TitleBar(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    void window.workstation.window.isMaximized().then(setMaximized);
    return window.workstation.window.onMaximizedChanged(setMaximized);
  }, []);

  return (
    <header className="titlebar" aria-label="窗口标题栏">
      <div className="titlebar__controls" aria-label="窗口控制">
        <button
          type="button"
          className="window-button"
          aria-label="最小化"
          title="最小化"
          onClick={() => void window.workstation.window.minimize()}
        >
          <Minus size={16} weight="regular" />
        </button>
        <button
          type="button"
          className="window-button"
          aria-label={maximized ? "还原" : "最大化"}
          title={maximized ? "还原" : "最大化"}
          onClick={() => void window.workstation.window.toggleMaximize()}
        >
          {maximized ? <Copy size={14} weight="regular" /> : <Square size={14} weight="regular" />}
        </button>
        <button
          type="button"
          className="window-button window-button--close"
          aria-label="关闭"
          title="关闭"
          onClick={() => void window.workstation.window.close()}
        >
          <X size={17} weight="regular" />
        </button>
      </div>
    </header>
  );
}
