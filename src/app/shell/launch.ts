/**
 * Launch from outside: the app was started with a folder (`forkyard <folder> [--commit <sha>]`),
 * via a link (`forkyard://open?path=…&commit=…`), or a second instance has passed its request on
 * to this one. The shell then opens the repository in a tab – an existing tab is activated – and,
 * if given, shows the commit in the graph.
 *
 * The core only checks that the folder exists; whether it is a repository only `repoOpen` tells.
 * Whatever does not work is explained in one sentence – with the next sensible step.
 */
import { createElement, useEffect } from "react";
import { core, type LaunchRequest } from "../../core";
import { openInitDialogAt } from "../../screens/InitDialog/preset";
import { toast } from "../../ui/Feedback";
import { openRepositoryAt } from "../actions/repos";
import { confirm } from "../dialogs";
import { focusAreaSoon } from "../commands/focus";
import { shortSha } from "../format";
import { toCoreError } from "../errors";
import { useAppStore } from "../store";
import { t } from "../../i18n";

const folderName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

/** Whether the folder is already in the repository list (then the user opened it themselves). */
async function isKnownRepository(path: string): Promise<boolean> {
  const insensitive = /Windows|Macintosh|Mac OS/i.test(navigator.userAgent);
  const key = (text: string) => {
    const unified = text.replace(/[\\/]+/g, "/").replace(/\/$/, "");
    return insensitive ? unified.toLowerCase() : unified;
  };
  try {
    const repos = await core.repoList();
    return repos.some((repo) => key(repo.path) === key(path));
  } catch {
    return false;
  }
}

/**
 * A request from a `forkyard://` link can come from any web page. Before the app opens a folder
 * the user does not have in the list yet, it asks first – with the full path.
 */
async function confirmedByUser(request: LaunchRequest): Promise<boolean> {
  if (!request.fromLink || request.invalid) return true;
  if (await isKnownRepository(request.path)) return true;
  return confirm({
    title: t("shell.launch.confirmTitle"),
    // The path is shown untruncated (wrapping, selectable): the user decides based on it.
    body: createElement(
      "span",
      null,
      t("shell.launch.confirmText"),
      createElement("span", { className: "selectable mt-2 block font-mono text-code break-all text-text", "data-launch-path": true }, request.path),
      createElement("span", { className: "mt-2 block" }, t("shell.launch.confirmWarning")),
    ),
    confirmLabel: t("shell.launch.openFolder"),
  });
}

/** Opens the request's folder and shows the commit. Requests run one after another. */
async function handle(request: LaunchRequest): Promise<void> {
  if (request.invalid === "path_not_allowed") {
    // Do not even check the path: on Windows that alone would contact the foreign machine.
    toast({
      tone: "warning",
      sticky: true,
      title: t("shell.launch.blockedTitle"),
      description: t("shell.launch.blockedText", { path: request.path }),
    });
    return;
  }
  if (!(await confirmedByUser(request))) return;
  const opened = await openRepositoryAt(request.path, { quiet: ["not_a_repo", "path_not_found"] });
  if (!opened.ok) {
    const { code } = opened.error;
    if (code === "not_a_repo") {
      toast({
        tone: "warning",
        sticky: true,
        title: t("shell.launch.notRepoTitle", { name: folderName(request.path) }),
        description: t("shell.launch.notRepoText", { path: request.path }),
        action: { label: t("shell.launch.initHere"), onClick: () => openInitDialogAt(request.path) },
      });
    } else if (code === "path_not_found") {
      toast({
        tone: "warning",
        sticky: true,
        title: t("shell.launch.notFoundTitle"),
        description: t("shell.launch.notFoundText", { path: request.path }),
      });
    }
    // Everything else has already been reported by openRepositoryAt.
    return;
  }

  const { repo, tab } = opened.value;
  // If the repository brings its own commands, the tab now shows the prompt about them – the core
  // runs nothing there, and it only shows the commit after consent.
  if (!repo.trusted) return;
  const store = useAppStore.getState();
  // The graph is the view in which a request from outside arrives – not a diff from earlier.
  store.closeCenter(tab.id);
  if (request.commit) {
    try {
      // The SHA may be abbreviated: the core resolves it.
      const details = await core.commitDetails({ repoId: repo.id, source: { kind: "commit", sha: request.commit } });
      const sha = details.commit?.sha ?? request.commit;
      store.revealCommit(tab.id, sha);
      store.setRightCollapsed(tab.id, false);
    } catch (raw) {
      const error = toCoreError(raw);
      toast({
        tone: "warning",
        sticky: true,
        title: t("shell.launch.commitNotFoundTitle", { sha: shortSha(request.commit) }),
        description:
          error.code === "not_found" || error.code === "unknown"
            ? t("shell.launch.commitNotFoundText", { name: repo.alias ?? repo.name })
            : error.message,
      });
    }
  }
  focusAreaSoon("center");
}

let queue: Promise<void> = Promise.resolve();
const enqueue = (request: LaunchRequest) => {
  queue = queue.then(() => handle(request)).catch(() => undefined);
};

let attached = false;

/**
 * Once in the shell, as soon as it is up: first listen for `app:open_request`, then fetch the
 * request of our own launch (the core sends further ones only after that, as events).
 */
export function useLaunchRequests(ready: boolean): void {
  useEffect(() => {
    if (!ready || attached) return;
    attached = true;
    core.on("app:open_request", enqueue);
    void core
      .appLaunchRequest()
      .then((request) => {
        if (request) enqueue(request);
      })
      .catch(() => undefined);
  }, [ready]);
}
