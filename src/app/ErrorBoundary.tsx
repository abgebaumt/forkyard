import { Component, type ErrorInfo, type ReactNode } from "react";
import { core } from "../core";
import { t } from "../i18n";

interface State {
  error: Error | null;
  busy: boolean;
}

/**
 * Catches errors while rendering the UI. Without this boundary a single error in one row
 * (say, a date that cannot be formatted) tears down the whole tree: the window stays empty –
 * and because the tab is remembered, after every restart too.
 *
 * The way out "Reload without the open tabs" therefore first closes all repository tabs: if the
 * error is caused by a particular repository, the app then starts in repository management again.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, busy: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Error while rendering the UI:", error, info.componentStack);
  }

  private reload = () => window.location.reload();

  private reloadWithoutTabs = async () => {
    this.setState({ busy: true });
    try {
      const tabs = await core.tabsList();
      for (const tab of tabs) {
        if (tab.repoId) await core.tabClose({ tabId: tab.id });
      }
    } catch {
      // If the list cannot be read, only the plain reload remains.
    }
    window.location.reload();
  };

  render() {
    const { error, busy } = this.state;
    if (!error) return this.props.children;
    return (
      <main data-shell="crashed" role="alert" className="flex h-full items-center justify-center overflow-auto bg-bg p-8 text-text">
        <div className="flex max-w-xl flex-col gap-4">
          <h1 className="text-lg font-semibold">{t("app.errorBoundary.title")}</h1>
          <p className="text-text-muted">{t("app.errorBoundary.text")}</p>
          <pre className="max-h-40 overflow-auto rounded-md border border-border bg-surface p-3 font-mono text-code whitespace-pre-wrap text-text-muted">
            {String(error.message || error)}
          </pre>
          <div className="flex flex-wrap gap-2">
            <button type="button" autoFocus disabled={busy} onClick={this.reload} className="rounded-md bg-accent px-3 py-1.5 font-medium text-on-accent">
              {t("app.errorBoundary.reload")}
            </button>
            <button type="button" disabled={busy} onClick={this.reloadWithoutTabs} className="rounded-md border border-border px-3 py-1.5">
              {t("app.errorBoundary.reloadWithoutTabs")}
            </button>
          </div>
        </div>
      </main>
    );
  }
}
