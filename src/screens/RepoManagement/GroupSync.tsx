/**
 * Batch fetch and batch pull for a group of repositories (local workspace): a dialog with one row
 * per repository – waiting, running (with progress), result or reason of failure. Each repository
 * runs as its own job in the core (`fetch` or `pull`), at most three at a time; an error in one
 * does not stop the others.
 *
 * Pull uses each repository's pull mode (its own setting, otherwise the global one) and acts on the
 * branch checked out there. Nothing is forced: if uncommitted changes are in the way or a conflict
 * arises, the row says so – it is resolved in the repository's tab.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDownToLine, Check, CircleSlash, CloudDownload, FolderX, Hourglass, Minus, OctagonAlert, RotateCw, TriangleAlert } from "lucide-react";
import { core, type Id, type Repo, type Settings } from "../../core";
import { openRepoTab } from "../../app/actions/repos";
import { showDialog } from "../../app/dialogs";
import { describeError, toCoreError } from "../../app/errors";
import { markManualSync } from "../../app/notify";
import { qk, queryClient } from "../../app/queries";
import { newJobId } from "../../app/run";
import { Button, Spinner } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { cn } from "../../ui/cn";
import { displayName } from "./repoActions";
import { t } from "../../i18n";

export type GroupSyncKind = "fetch" | "pull";

/** How many repositories run at the same time. */
const PARALLEL = 3;

type RowStatus = "waiting" | "running" | "done" | "unchanged" | "attention" | "failed" | "cancelled";

interface RowState {
  status: RowStatus;
  /** Result or reason, one sentence. */
  text: string;
  /** Running job: phase and progress from `job:progress`. */
  phase: string;
  percent: number | null;
  jobId: string | null;
  /** Conflict after the pull: the row offers to open the repository. */
  offerOpen: boolean;
}

const waiting = (): RowState => ({ status: "waiting", text: t("repos.sync.waiting"), phase: "", percent: null, jobId: null, offerOpen: false });

const kindInfo: Record<GroupSyncKind, { dialogTitle: (group: string) => string; title: string; running: string; description: (repos: string) => string; icon: typeof CloudDownload }> = {
  fetch: {
    dialogTitle: (group) => t("repos.sync.fetch.dialogTitle", { group }),
    title: t("repos.sync.fetch.title"),
    running: t("repos.sync.fetch.running"),
    description: (repos) => t("repos.sync.fetch.description", { repos }),
    icon: CloudDownload,
  },
  pull: {
    dialogTitle: (group) => t("repos.sync.pull.dialogTitle", { group }),
    title: t("repos.sync.pull.title"),
    running: t("repos.sync.pull.running"),
    description: (repos) => t("repos.sync.pull.description", { repos }),
    icon: ArrowDownToLine,
  },
};

type Outcome = Pick<RowState, "status" | "text"> & { offerOpen?: boolean };

/** Fetch or pull one repository; returns what its row should show. Never throws. */
async function runOne(repo: Repo, kind: GroupSyncKind, jobId: string): Promise<Outcome> {
  if (repo.missing) return { status: "failed", text: t("repos.sync.missing") };
  markManualSync(repo.id);
  try {
    if (kind === "fetch") {
      const prune = queryClient.getQueryData<Settings>(qk.settings)?.autoPrune ?? false;
      const result = await core.fetch({ repoId: repo.id, jobId, remote: null, prune });
      const changed = result.updatedRefs + result.prunedRefs;
      const parts = [t("repos.sync.refsUpdated", { count: result.updatedRefs })];
      if (result.prunedRefs) parts.push(t("repos.sync.pruned", { count: result.prunedRefs }));
      if (result.failed.length) {
        const first = result.failed[0]!;
        const reason = `${first.remote}: ${first.message}${result.failed.length > 1 ? t("repos.sync.moreFailed", { count: result.failed.length - 1 }) : ""}`;
        // If something came from other remotes it is a partial success; otherwise a failure.
        return changed ? { status: "attention", text: t("repos.sync.partial", { parts: parts.join(", "), reason }) } : { status: "failed", text: reason };
      }
      return changed ? { status: "done", text: parts.join(", ") } : { status: "unchanged", text: t("repos.sync.nothingNew") };
    }
    const result = await core.pull({ repoId: repo.id, jobId, mode: null });
    if (result.status === "up_to_date") return { status: "unchanged", text: t("repos.sync.upToDate") };
    if (result.status === "conflict") {
      const count = result.files.length;
      return {
        status: "attention",
        text: count ? t("repos.sync.conflict", { count }) : t("repos.sync.paused"),
        offerOpen: true,
      };
    }
    return { status: "done", text: result.summary || (result.fastForward ? t("repos.sync.fastForward") : t("repos.sync.updated")) };
  } catch (raw) {
    const error = toCoreError(raw);
    switch (error.code) {
      case "cancelled":
        return { status: "cancelled", text: t("repos.sync.cancelled") };
      case "path_not_found":
      case "not_a_repo":
        return { status: "failed", text: t("repos.sync.missing") };
      case "no_remote":
        return { status: "unchanged", text: t("repos.sync.noRemote") };
      case "no_upstream":
        return { status: "unchanged", text: t("repos.sync.noUpstream") };
      case "dirty_worktree":
        return { status: "failed", text: t("repos.sync.dirty"), offerOpen: true };
      case "operation_in_progress":
        return { status: "failed", text: t("repos.sync.inProgress"), offerOpen: true };
      default: {
        const { text } = describeError(error);
        return { status: "failed", text };
      }
    }
  } finally {
    markManualSync(repo.id);
  }
}

const statusIcon: Record<RowStatus, ReactNode> = {
  waiting: <Hourglass className="size-icon text-text-muted" aria-hidden />,
  running: <Spinner />,
  done: <Check className="size-icon text-success" aria-hidden />,
  unchanged: <Minus className="size-icon text-text-muted" aria-hidden />,
  attention: <TriangleAlert className="size-icon text-warning" aria-hidden />,
  failed: <OctagonAlert className="size-icon text-danger" aria-hidden />,
  cancelled: <CircleSlash className="size-icon text-text-muted" aria-hidden />,
};

/** State in one word – read by screen readers before the row's sentence (never just the icon). */
const statusWord: Record<RowStatus, string> = {
  waiting: t("repos.sync.status.waiting"),
  running: t("repos.sync.status.running"),
  done: t("repos.sync.status.done"),
  unchanged: t("repos.sync.status.unchanged"),
  attention: t("repos.sync.status.attention"),
  failed: t("repos.sync.status.failed"),
  cancelled: t("repos.sync.status.cancelled"),
};

function summarize(rows: RowState[], kind: GroupSyncKind): string {
  const count = (status: RowStatus) => rows.filter((row) => row.status === status).length;
  const open = count("waiting") + count("running");
  if (open) return t("repos.sync.summary.progress", { done: rows.length - open, total: rows.length });
  const parts: string[] = [];
  const done = count("done");
  if (done) parts.push(kind === "fetch" ? t("repos.sync.summary.withNew", { count: done }) : t("repos.sync.summary.updated", { count: done }));
  if (count("unchanged")) parts.push(t("repos.sync.summary.unchanged", { count: count("unchanged") }));
  if (count("attention")) parts.push(t("repos.sync.summary.attention", { count: count("attention") }));
  if (count("failed")) parts.push(t("repos.sync.summary.failed", { count: count("failed") }));
  if (count("cancelled")) parts.push(t("repos.sync.summary.cancelled", { count: count("cancelled") }));
  return parts.join(" · ");
}

function GroupSyncDialog({ group, repos, kind, onClose }: { group: string; repos: Repo[]; kind: GroupSyncKind; onClose: () => void }) {
  const info = kindInfo[kind];
  const [rows, setRows] = useState<Record<Id, RowState>>(() => Object.fromEntries(repos.map((repo) => [repo.id, waiting()])));
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const stopped = useRef(false);
  const started = useRef(false);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const patch = useCallback((id: Id, change: Partial<RowState>) => setRows((current) => ({ ...current, [id]: { ...(current[id] ?? waiting()), ...change } })), []);

  /** Runs the given repositories, at most `PARALLEL` at a time. */
  const run = useCallback(
    async (list: Repo[]) => {
      stopped.current = false;
      setCancelling(false);
      setRunning(true);
      for (const repo of list) patch(repo.id, waiting());
      const queue = [...list];
      const worker = async () => {
        for (;;) {
          const repo = queue.shift();
          if (!repo) return;
          if (stopped.current) {
            patch(repo.id, { status: "cancelled", text: t("repos.sync.cancelled"), jobId: null });
            continue;
          }
          const jobId = newJobId();
          patch(repo.id, { status: "running", text: info.running, phase: "", percent: null, jobId, offerOpen: false });
          const outcome = await runOne(repo, kind, jobId);
          patch(repo.id, { ...outcome, offerOpen: outcome.offerOpen ?? false, jobId: null, phase: "", percent: null });
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, list.length) }, worker));
      setRunning(false);
      // The list shows "last opened" and missing folders; after a run that may have changed.
      void queryClient.invalidateQueries({ queryKey: qk.repos });
    },
    [info.running, kind, patch],
  );

  // Start once on open (even if React runs the effect twice in development).
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run(repos);
  }, [run, repos]);

  // Progress of the running jobs.
  useEffect(
    () =>
      core.on("job:progress", ({ jobId, phase, percent, line }) => {
        const entry = Object.entries(rowsRef.current).find(([, row]) => row.jobId === jobId);
        if (entry) patch(entry[0], { phase: phase || line, percent });
      }),
    [patch],
  );

  // Once the run is over, "Cancel" disappears – focus goes to "Close" so Enter is enough.
  const body = useRef<HTMLDivElement>(null);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) body.current?.closest('[role="dialog"]')?.querySelector<HTMLElement>("[data-group-sync-close]")?.focus();
    wasRunning.current = running;
  }, [running]);

  const cancel = () => {
    stopped.current = true;
    setCancelling(true);
    for (const row of Object.values(rowsRef.current)) if (row.jobId) void core.jobCancel({ jobId: row.jobId }).catch(() => undefined);
  };

  const list = repos.map((repo) => ({ repo, row: rows[repo.id] ?? waiting() }));
  const states = list.map((item) => item.row);
  const retry = repos.filter((repo) => ["failed", "cancelled"].includes(rows[repo.id]?.status ?? ""));
  const Icon = info.icon;

  return (
    <Dialog
      open
      // While something is running, Esc or "Close" first cancels; the result stays.
      onOpenChange={(open) => {
        if (open) return;
        if (running) cancel();
        else onClose();
      }}
      size="md"
      title={info.dialogTitle(group)}
      description={info.description(t("repos.count", { count: repos.length }))}
      footer={
        <>
          {running ? (
            <Button data-autofocus loading={cancelling} onClick={cancel}>
              {cancelling ? t("repos.sync.cancelling") : t("repos.sync.cancel")}
            </Button>
          ) : (
            <>
              {retry.length ? (
                <Button icon={<RotateCw className="size-icon" aria-hidden />} onClick={() => void run(retry)}>
                  {t("repos.sync.retry", { count: retry.length })}
                </Button>
              ) : null}
              <Button variant="primary" data-autofocus data-group-sync-close="" onClick={onClose}>
                {t("repos.sync.close")}
              </Button>
            </>
          )}
        </>
      }
    >
      <div ref={body} data-group-sync={kind} data-running={running || undefined} className="flex flex-col gap-2">
        <p role="status" aria-live="polite" data-group-sync-summary="" className="flex items-center gap-2 text-sm text-text-muted">
          <Icon className="size-icon shrink-0" aria-hidden />
          <span>{summarize(states, kind)}</span>
        </p>
        <ul aria-label={t("repos.sync.listLabel", { group })} className="flex max-h-80 flex-col overflow-y-auto rounded-md border border-border bg-surface-sunken">
          {list.map(({ repo, row }) => (
            <li key={repo.id} data-repo-id={repo.id} data-status={row.status} className="flex min-h-11 shrink-0 items-start gap-2.5 border-b border-border px-3 py-1.5 last:border-b-0">
              <span className="mt-0.5 flex size-icon shrink-0 items-center justify-center">{repo.missing ? <FolderX className="size-icon text-warning" aria-hidden /> : statusIcon[row.status]}</span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium" title={repo.path}>
                  {displayName(repo)}
                </span>
                <span className={cn("selectable text-sm break-words", row.status === "failed" ? "text-danger" : row.status === "attention" ? "text-warning" : "text-text-muted")}>
                  <span className="sr-only">{statusWord[row.status]}: </span>
                  {row.status === "running" && row.phase ? `${row.phase}${row.percent !== null ? ` · ${Math.round(row.percent)} %` : ""}` : row.text}
                </span>
                {row.status === "running" ? (
                  <span
                    role="progressbar"
                    aria-label={t("repos.sync.progressLabel", { kind: info.title, name: displayName(repo) })}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={row.percent ?? undefined}
                    className="mt-1 h-0.5 w-full overflow-hidden rounded-pill bg-border"
                  >
                    <span className={cn("block h-full bg-accent", row.percent === null && "w-1/3 animate-pulse")} style={row.percent !== null ? { width: `${Math.max(2, Math.min(100, row.percent))}%` } : undefined} />
                  </span>
                ) : null}
              </span>
              {row.offerOpen && !repo.missing ? (
                <Button
                  size="sm"
                  onClick={() => {
                    onClose();
                    void openRepoTab(repo.id);
                  }}
                >
                  {t("repos.sync.open")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}

/** Opens the dialog and starts the run. Resolves when the dialog is closed. */
export function openGroupSync(group: string, repos: Repo[], kind: GroupSyncKind): Promise<null> {
  return showDialog<null>((done) => <GroupSyncDialog group={group} repos={repos} kind={kind} onClose={() => done(null)} />);
}
