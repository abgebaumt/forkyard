/**
 * LFS locks in the LFS panel: list with filter, multiple selection, “Unlock” (own locks) and
 * “Force unlock …” (asks before removing other people's locks). Errors are a state of this
 * section, not a message at the edge; a server without locking says so here.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { LockOpen, RefreshCw, TriangleAlert } from "lucide-react";
import { CoreError, type Id } from "../../core";
import { lfsBusyKey, refreshLocks, unlockFiles } from "../../app/actions/lfs";
import { describeError } from "../../app/errors";
import { formatDateTime, formatRelative } from "../../app/format";
import { useLfsLocks } from "../../app/queries";
import { useBusy } from "../../app/store";
import { Button } from "../../ui/Button";
import { Checkbox, TextField } from "../../ui/Field";
import { t } from "../../i18n";
import { panelActions } from "./locks";

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function LocksError({ error }: { error: unknown }) {
  const { text, hint } = describeError(error);
  return (
    <div role="alert" data-lfs-locks-state="error" className="flex items-start gap-3 rounded-md border border-border bg-danger-surface p-3">
      <TriangleAlert className="mt-0.5 size-icon shrink-0 text-danger" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-text">{t("lfs.locks.readFailed")}</p>
        <p className="selectable text-sm break-words text-text-muted">{hint ? `${text} ${hint}` : text}</p>
      </div>
    </div>
  );
}

export function LocksSection({ repoId }: { repoId: Id }) {
  const headingId = useId();
  const [text, setText] = useState("");
  const needle = useDebounced(text.trim(), 200);
  const locks = useLfsLocks(repoId, needle || null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const busy = useBusy(lfsBusyKey(repoId, "locks"));
  const shown = useMemo(() => locks.data?.locks ?? [], [locks.data]);
  const actions = panelActions(shown, selected);

  // Locks that are gone (unlocked, filtered away) leave the selection.
  useEffect(() => {
    setSelected((current) => {
      const next = new Set(shown.filter((lock) => current.has(lock.path)).map((lock) => lock.path));
      return next.size === current.size ? current : next;
    });
  }, [shown]);

  const toggle = (path: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });

  const unsupported = locks.error instanceof CoreError && locks.error.code === "unsupported";

  return (
    <section aria-labelledby={headingId} data-lfs-locks className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span id={headingId} className="text-sm font-medium text-text-muted">
          {t("lfs.locks.heading")} {locks.data ? <span className="font-normal tabular-nums">{shown.length}</span> : null}
        </span>
        <Button size="sm" variant="ghost" loading={busy} title={t("lfs.locks.refreshLabel")} icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={() => void refreshLocks(repoId)}>
          {t("lfs.locks.refresh")}
        </Button>
      </div>
      <p className="text-sm text-text-muted">{t("lfs.locks.intro")}</p>

      {unsupported ? (
        <p data-lfs-locks-state="unsupported" className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-text-muted">
          {t("lfs.locks.unsupported")}
        </p>
      ) : locks.isError ? (
        <LocksError error={locks.error} />
      ) : (
        <>
          {/* The filter stays mounted while a filtered list loads – otherwise typing would lose focus. */}
          <TextField
            label={t("lfs.locks.filter")}
            value={text}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(event) => setText(event.target.value)}
          />
          {locks.isPending ? (
            <div role="status" aria-label={t("lfs.locks.loading")} data-lfs-locks-state="loading" className="flex animate-pulse flex-col gap-2 py-1">
              <div className="h-row rounded-md bg-surface-raised" />
              <div className="h-row rounded-md bg-surface-raised" />
            </div>
          ) : shown.length === 0 ? (
            <p data-lfs-locks-state="empty" className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-text-muted">
              {needle ? t("lfs.locks.emptyFiltered", { filter: needle }) : t("lfs.locks.empty")}
            </p>
          ) : (
            <ul aria-label={t("lfs.locks.listLabel")} className="max-h-56 overflow-y-auto rounded-md border border-border bg-surface-sunken py-1">
              {shown.map((lock) => (
                <li key={lock.path} data-lock-path={lock.path} data-lock-ours={lock.ours ? "" : undefined} className="flex items-center gap-2 px-2 py-1 hover:bg-surface-raised">
                  <div className="min-w-0 flex-1">
                    <Checkbox
                      label={
                        <span className="block truncate font-mono text-code" title={lock.path}>
                          {lock.path}
                        </span>
                      }
                      checked={selected.has(lock.path)}
                      onCheckedChange={(on) => toggle(lock.path, on)}
                    />
                  </div>
                  <span className="shrink-0 text-sm text-text-muted" title={lock.lockedAt ? formatDateTime(lock.lockedAt) : undefined}>
                    {lock.ours ? t("lfs.locks.you") : lock.owner}
                    {lock.lockedAt ? ` · ${formatRelative(lock.lockedAt)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" icon={<LockOpen className="size-3.5" aria-hidden />} disabled={actions.unlock.length === 0 || busy} onClick={() => void unlockFiles(repoId, actions.unlock, false)}>
              {t("lfs.locks.unlock")}
            </Button>
            <Button size="sm" variant="danger" disabled={actions.force.length === 0 || busy} onClick={() => void unlockFiles(repoId, actions.force, true)}>
              {t("lfs.locks.force")}
            </Button>
            {selected.size > 0 ? (
              <span role="status" className="text-sm text-text-muted">
                {t("lfs.locks.selected", { count: selected.size })}
              </span>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
