import { useState } from "react";
import { INSTALLABLE, isIos, isStandalone, useInstallPrompt } from "./pwa";
import type { SuiteApp } from "./suite";

/** "Install Notes" in the top bar, when the browser can install the current app. */
export function InstallButton({ app }: { app?: SuiteApp }) {
  const { available, install } = useInstallPrompt();
  const [hint, setHint] = useState(false);
  if (isStandalone() || (app && !INSTALLABLE.includes(app.id))) return null;
  const name = app?.name ?? "Markdown Studio";

  if (available)
    return (
      <button type="button" className="menu-button install-button" onClick={install}>
        Install {name}
      </button>
    );
  if (!isIos()) return null;
  return (
    <div className="menu">
      <button type="button" className="menu-button install-button" aria-expanded={hint} onClick={() => setHint((h) => !h)}>
        Install {name}
      </button>
      {hint && (
        <div className="menu-list install-hint" role="status">
          <p>
            In Safari, tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>. {name} then opens like an app, and works offline.
          </p>
        </div>
      )}
    </div>
  );
}
