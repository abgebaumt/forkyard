/**
 * Guard when closing the window (×, Alt+F4, logging out): if something would be lost – unsaved
 * text in the editor, an unsaved resolution in the conflict tool, a running action such as a
 * clone – the app asks first.
 *
 * The core does not know what is open in the UI. So the UI keeps telling it WHETHER there is
 * something to lose (`appCloseGuard`); only then does the window stop on close and send
 * `app:close_requested`. If the UI does not answer (it hangs), the next close closes anyway –
 * nobody stays trapped in the app.
 */
import { core } from "../core";
import { t } from "../i18n";
import { discardUnsaved, onUnsavedChange, saveUnsaved, unsavedFiles } from "../screens/FileView/buffer";
import { choose, confirm } from "./dialogs";
import { hasDirtyCenter, useAppStore } from "./store";
import { toast } from "../ui/Feedback";

export interface Losses {
  /** Files with unsaved text in the editor. */
  files: string[];
  /** Unsaved work in a view (conflict tool, pull request form). */
  views: boolean;
  /** Titles of the running actions. */
  jobs: string[];
  /** Coding agents whose programs run (they are ended). */
  agents: number;
}

function losses(): Losses {
  const state = useAppStore.getState();
  return {
    files: unsavedFiles().map((file) => file.path),
    views: hasDirtyCenter(),
    jobs: Object.values(state.jobs)
      .filter((job) => job.askBeforeQuit)
      .map((job) => job.title),
    agents: state.agentsRunning,
  };
}

const anything = (now: Losses) => now.files.length > 0 || now.views || now.jobs.length > 0 || now.agents > 0;

let reported: boolean | null = null;
function sync() {
  const active = anything(losses());
  if (active === reported) return;
  reported = active;
  void core.appCloseGuard({ active }).catch(() => {
    // Without the core (preview in the browser) there is no window to guard.
    reported = null;
  });
}

let asking = false;
async function onCloseRequested() {
  // Sign of life: the dialog is about to appear. Without this the next × would close the window.
  void core.appCloseGuard({ active: true }).catch(() => undefined);
  if (asking) return;
  asking = true;
  try {
    const now = losses();
    if (!anything(now)) {
      await core.appQuit();
      return;
    }
    const lines: string[] = [];
    if (now.jobs.length > 0) lines.push(now.jobs.length === 1 ? t("app.closeGuard.jobRunning", { job: now.jobs[0] }) : t("app.closeGuard.jobsRunning", { count: now.jobs.length }));
    if (now.agents > 0) lines.push(t("app.closeGuard.agentsRunning", { count: now.agents }));
    if (now.views) lines.push(t("app.closeGuard.dirtyView"));
    if (now.files.length > 0) {
      lines.push(t("app.closeGuard.unsavedText", { count: now.files.length }));
      const answer = await choose({
        title: t("app.closeGuard.title"),
        description: lines.join(" "),
        details: now.files,
        detailsLabel: t("app.closeGuard.unsavedFiles", { count: now.files.length }),
        options: [
          { key: "save", label: t("app.closeGuard.save"), description: t("app.closeGuard.saveHint", { count: now.files.length }) },
          { key: "discard", label: t("app.closeGuard.discard"), description: t("app.closeGuard.discardHint"), danger: true },
        ],
      });
      if (answer === null) return;
      if (answer === "save") {
        const failed = await saveUnsaved();
        if (failed.length > 0) {
          toast({ tone: "danger", title: t("app.closeGuard.saveFailed"), description: t("app.closeGuard.saveFailedText", { files: failed.join(", ") }) });
          return;
        }
      } else {
        discardUnsaved();
      }
    } else {
      const ok = await confirm({ title: t("app.closeGuard.title"), body: lines.join(" "), confirmLabel: t("app.closeGuard.quit"), danger: true });
      if (!ok) return;
    }
    await core.appQuit();
  } finally {
    asking = false;
    // Cancelled: the guard stays in effect.
    reported = null;
    sync();
  }
}

/** Call once at startup. */
export function installCloseGuard(): void {
  onUnsavedChange(sync);
  useAppStore.subscribe((state, previous) => {
    if (state.jobs !== previous.jobs || state.agentsRunning !== previous.agentsRunning) sync();
  });
  // Views with unsaved work (conflict tool) do not report changes individually.
  window.setInterval(sync, 1000);
  core.on("app:close_requested", () => void onCloseRequested());
  sync();
}
