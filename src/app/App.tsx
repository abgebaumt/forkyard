/**
 * The shell: tab strip, toolbar, Left Panel | centre | Commit Panel, status bar,
 * plus overlays, dialog host, credential prompts, shortcuts and events from the core.
 */
import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PlugZap, RefreshCw, TriangleAlert } from "lucide-react";
import { startupMark, type AppInfo, type Platform, type Settings, type Tab } from "../core";
import { Button } from "../ui/Button";
import { setShortcutPlatform } from "../ui/shortcut";
import { AgentWatch } from "../screens/Agents/Watch";
import { RepoManagement } from "../screens/RepoManagement";
import { runScenarioFromUrl } from "../screens/scenarios";
import { DialogHost } from "./dialogs";
import { t } from "../i18n";
import { describeError } from "./errors";
import { useCustomCommandRegistration } from "../screens/CustomCommands/register";
import { queryClient, useAppInfo, useCoreSync, useRepoLocked, useRepoMissing, useSettings, useTabs } from "./queries";
import { useGlobalShortcuts } from "./registry";
import { NARROW_WINDOW, useAppStore } from "./store";
import { useEffectiveZoom } from "./zoom";
import { CredentialHost } from "./shell/CredentialHost";
import { FullPage, StartupScreen } from "./shell/FullPage";
import { OverlayHost } from "./shell/OverlayHost";
import { ManagementToolbar, RepoToolbar } from "./shell/RepoToolbar";
import { RepoWorkspace } from "./shell/RepoWorkspace";
import { useLaunchRequests } from "./shell/launch";
import { useCrashReportsOnStart } from "../screens/CrashReport";
import { useStartFocus } from "./shell/startFocus";
import { StatusLine } from "./shell/StatusLine";
import { TabStrip } from "./shell/TabStrip";
import { useUpdateChecks } from "./updates";
import { useAiIntro } from "./ai/intro";

const APP_NAME = "forkyard";

/** "2.45.1.windows.1" ≥ "2.39"? */
export function versionAtLeast(version: string, minimum: string): boolean {
  const parse = (value: string) => value.split(/[^0-9]+/).filter(Boolean).slice(0, 3).map(Number);
  const a = parse(version);
  const b = parse(minimum);
  for (let index = 0; index < 3; index++) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

/** A scenario (?scenario=…, development only) sets up the view itself – including focus. */
const hasScenario = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("scenario");

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const gitInstallHint: Record<Platform, string> = {
  windows: t("app.startup.installGit.windows"),
  linux: t("app.startup.installGit.linux"),
  macos: t("app.startup.installGit.macos"),
};

export function App() {
  const appInfo = useAppInfo();
  useEffect(() => startupMark("paint"), []);

  if (appInfo.isPending) return <StartupScreen />;

  if (appInfo.isError) {
    const { text } = describeError(appInfo.error);
    return (
      <FullPage
        icon={<PlugZap className="size-8" aria-hidden />}
        title={t("app.startup.coreDown.title")}
        details={isTauri() ? text : null}
        actions={
          <Button icon={<RefreshCw className="size-icon" aria-hidden />} onClick={() => void appInfo.refetch()}>
            {t("app.startup.retry")}
          </Button>
        }
      >
        {isTauri() ? (
          <p>{t("app.startup.coreDown.desktop")}</p>
        ) : (
          <p>{t("app.startup.coreDown.browser", { app: APP_NAME })}</p>
        )}
      </FullPage>
    );
  }

  const info = appInfo.data;
  setShortcutPlatform(info.platform);

  if (!info.gitVersion) {
    return (
      <FullPage
        icon={<TriangleAlert className="size-8" aria-hidden />}
        title={t("app.startup.gitMissing.title")}
        actions={
          <Button icon={<RefreshCw className="size-icon" aria-hidden />} onClick={() => void appInfo.refetch()}>
            {t("app.startup.recheck")}
          </Button>
        }
      >
        <p>{t("app.startup.gitMissing.uses", { app: APP_NAME, version: info.gitMinVersion })}</p>
        <p>{gitInstallHint[info.platform]}</p>
        <p>{t("app.startup.gitMissing.restart", { app: APP_NAME })}</p>
      </FullPage>
    );
  }

  if (!versionAtLeast(info.gitVersion, info.gitMinVersion)) {
    return (
      <FullPage
        icon={<TriangleAlert className="size-8" aria-hidden />}
        title={t("app.startup.gitTooOld.title")}
        details={info.gitPath ? t("app.startup.gitTooOld.foundAt", { version: info.gitVersion, path: info.gitPath }) : t("app.startup.gitTooOld.found", { version: info.gitVersion })}
        actions={
          <Button icon={<RefreshCw className="size-icon" aria-hidden />} onClick={() => void appInfo.refetch()}>
            {t("app.startup.recheck")}
          </Button>
        }
      >
        <p>{t("app.startup.gitTooOld.text", { version: info.gitVersion, app: APP_NAME, minimum: info.gitMinVersion })}</p>
        <p>{gitInstallHint[info.platform]}</p>
      </FullPage>
    );
  }

  return <Shell info={info} />;
}

function Shell({ info }: { info: AppInfo }) {
  const tabsQuery = useTabs();
  const { data: settings } = useSettings();
  const tabs = [...(tabsQuery.data ?? [])].sort((a, b) => a.position - b.position);
  const active = tabs.find((tab) => tab.isActive) ?? tabs[0] ?? null;
  const repoId = active?.kind === "repo" ? active.repoId : null;

  // If the folder is missing or the repository is locked (own commands, no consent yet),
  // there is nothing to operate there: no toolbar, no repository status bar.
  const locked = useRepoLocked(repoId);
  const missing = useRepoMissing(locked ? null : repoId) || locked;

  useCoreSync(locked ? null : repoId);
  useCustomCommandRegistration(locked ? null : repoId);
  useGlobalShortcuts(info.platform === "macos");
  useAppearance(settings);
  useWindowTitle(active);
  const zoom = useEffectiveZoom(settings?.zoom ?? 1);
  useNarrowWindow(zoom);
  useStartupScenario(tabsQuery.isSuccess);
  useStartFocus(tabsQuery.isSuccess && !hasScenario, repoId ? "repo" : "management");
  useLaunchRequests(tabsQuery.isSuccess);
  // Not during a scenario (screenshots, tests): a dialog would cover the view.
  useCrashReportsOnStart(tabsQuery.isSuccess && !hasScenario);
  useUpdateChecks(tabsQuery.isSuccess ? settings?.checkForUpdates : undefined);
  useAiIntro(tabsQuery.isSuccess);
  useEffect(() => {
    if (!tabsQuery.isSuccess) return;
    startupMark("shell");
    if (!repoId) startupMark("management");
  }, [tabsQuery.isSuccess, repoId]);

  if (tabsQuery.isPending) return <StartupScreen />;
  if (tabsQuery.isError) {
    const { text, hint } = describeError(tabsQuery.error);
    return (
      <FullPage
        icon={<TriangleAlert className="size-8" aria-hidden />}
        title={t("app.startup.tabsFailed")}
        details={text}
        actions={
          <Button icon={<RefreshCw className="size-icon" aria-hidden />} onClick={() => void tabsQuery.refetch()}>
            {t("app.startup.retry")}
          </Button>
        }
      >
        {hint ? <p>{hint}</p> : null}
      </FullPage>
    );
  }

  const repoTab = active?.kind === "repo" && repoId ? active : null;

  return (
    <div data-shell="app" data-no-scroll className="flex h-full flex-col bg-bg text-text">
      <TabStrip tabs={tabs} />
      {repoTab && repoId && !missing ? <RepoToolbar key={`toolbar-${repoTab.id}`} repoId={repoId} tabId={repoTab.id} /> : <ManagementToolbar />}
      {repoTab && repoId ? (
        <RepoWorkspace key={`workspace-${repoTab.id}`} tab={repoTab} repoId={repoId} />
      ) : (
        <main aria-label={t("app.shell.management")} data-area="manage" className="flex min-h-0 flex-1 flex-col">
          <RepoManagement tabId={active?.id ?? null} />
        </main>
      )}
      <StatusLine repoId={missing ? null : repoId} />
      <AgentWatch tabs={tabs} />
      <OverlayHost repoId={repoId} />
      <DialogHost />
      <CredentialHost />
    </div>
  );
}

/** Theme (data-theme on the html element; "system" follows prefers-color-scheme) and zoom (CSS zoom on the root element). */
function useAppearance(settings: Settings | undefined) {
  const theme = settings?.theme;
  const zoom = settings?.zoom;

  useEffect(() => {
    // ?theme=light|dark (screenshots) takes precedence over the setting.
    if (!theme || new URLSearchParams(window.location.search).has("theme")) return;
    const root = document.documentElement;
    if (theme !== "system") {
      root.dataset.theme = theme;
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      root.dataset.theme = media.matches ? "light" : "dark";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  // What applies in the window is applied (zoom.ts): the configured zoom, as long as at least
  // 960x600 layout pixels remain. Sizes in vh/vw need `--zoom`: they do not grow with CSS zoom,
  // otherwise 85vh at 150 % would be 127 % of the visible height.
  const applied = useEffectiveZoom(zoom ?? 1);
  useEffect(() => {
    if (zoom === undefined) return;
    const root = document.documentElement;
    root.style.setProperty("zoom", String(applied));
    root.style.setProperty("--zoom", String(applied));
  }, [zoom, applied]);
}

function useWindowTitle(active: Tab | null) {
  const title = active?.kind === "repo" && active.title ? `${active.title} – ${APP_NAME}` : APP_NAME;
  useEffect(() => {
    document.title = title;
    // Needs the core:window:allow-set-title permission; without it the window title stays unchanged.
    try {
      void getCurrentWindow()
        .setTitle(title)
        .catch(() => undefined);
    } catch {
      // outside Tauri (tests) there is no window object
    }
  }, [title]);
}

/** "Narrow" counts in layout pixels: at 150 % zoom a 1440 px wide window has only 960 of them. */
function useNarrowWindow(zoom: number) {
  const setNarrow = useAppStore((state) => state.setNarrow);
  useEffect(() => {
    const check = () => setNarrow(window.innerWidth / zoom < NARROW_WINDOW);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [setNarrow, zoom]);
}

function useStartupScenario(ready: boolean) {
  const started = useRef(false);
  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true;
    void runScenarioFromUrl(queryClient);
  }, [ready]);
}
