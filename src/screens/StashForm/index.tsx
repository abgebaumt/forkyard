import { useId } from "react";
import { Archive, ArrowLeft } from "lucide-react";
import type { Id, Status } from "../../core";
import { busyKeys } from "../../app/actions/keys";
import { stashChanges } from "../../app/actions/stash";
import { qk, queryClient, useStatus } from "../../app/queries";
import { useAppStore, useBusy } from "../../app/store";
import { Button } from "../../ui/Button";
import { Checkbox, TextField } from "../../ui/Field";
import { Tip } from "../../ui/Tooltip";
import { ChangesPanel } from "../WipPanel/ChangesPanel";
import { useWipStore, useWipTab } from "../WipPanel/state";
import { currentPending, pendingCounts, toStashSelection, type PendingStash } from "./selection";
import { t } from "../../i18n";

export interface StashFormProps {
  repoId: Id;
  tabId: Id;
}

interface StashPlan {
  label: string;
  /** Why nothing can be stashed right now; null = possible. */
  blocked: string | null;
  /** null = all changes. */
  paths: string[] | null;
}

/** What "Create stash" would do right now: everything or only the checked files. */
function planStash(status: Status | undefined, marked: string[], onlyMarked: boolean, includeUntracked: boolean, pending: PendingStash | null): StashPlan {
  if (!status) return { label: t("stash.create"), blocked: t("stash.blocked.loading"), paths: null };
  if (status.head.kind === "unborn") return { label: t("stash.create"), blocked: t("stash.blocked.unborn"), paths: null };
  if (status.conflicted.length > 0) return { label: t("stash.create"), blocked: t("stash.blocked.conflicts"), paths: null };
  if (pending) return { label: t("partialStash.create"), blocked: null, paths: null };
  const untracked = new Set(status.unstaged.filter((file) => file.status === "untracked").map((file) => file.path));
  const changed = new Set([...status.unstaged, ...status.staged].map((file) => file.path));
  const usable = (path: string) => changed.has(path) && (includeUntracked || !untracked.has(path));
  if (onlyMarked && marked.length > 0) {
    const paths = [...new Set(marked)].filter(usable);
    if (paths.length === 0) return { label: t("stash.create"), blocked: t("stash.blocked.markedUntracked"), paths: null };
    return { label: t("stash.createFiles", { count: paths.length }), blocked: null, paths };
  }
  const all = [...changed].filter(usable);
  if (all.length === 0) {
    return {
      label: t("stash.create"),
      blocked: changed.size > 0 ? t("stash.blocked.onlyUntracked") : t("stash.blocked.nothing"),
      paths: null,
    };
  }
  return { label: t("stash.create"), blocked: null, paths: null };
}

function StashFields({ repoId, tabId }: StashFormProps) {
  const { data: status } = useStatus(repoId);
  const wip = useWipTab(tabId);
  const patch = useWipStore.getState().patch;
  const busy = useBusy(busyKeys.stash(repoId));
  const nameId = useId();

  const known = new Set([...(status?.unstaged ?? []), ...(status?.staged ?? [])].map((file) => file.path));
  const marked = [...new Set([...wip.selection.unstaged.selected, ...wip.selection.staged.selected])].filter((path) => known.has(path));
  const pending = currentPending(wip.stashSelection, status);
  const counts = pending ? pendingCounts(pending) : null;
  const onlyMarked = !pending && wip.stashOnlySelected && marked.length > 0;
  const plan = planStash(status, marked, onlyMarked, wip.stashUntracked, pending);
  const back = () => useAppStore.getState().setRightPanel(tabId, "details");

  const submit = async () => {
    // Fresh from the cache: the state may have changed between rendering and the click.
    const fresh = queryClient.getQueryData<Status>(qk.status(repoId));
    const selected = currentPending(useWipStore.getState().tabs[tabId]?.stashSelection ?? null, fresh);
    const current = planStash(fresh, marked, onlyMarked && !selected, wip.stashUntracked, selected);
    if (current.blocked) return;
    const result = await stashChanges(repoId, {
      message: wip.stashMessage,
      paths: selected ? null : current.paths,
      includeUntracked: wip.stashUntracked,
      selection: selected ? toStashSelection(selected) : null,
    });
    if (!result.ok) {
      // The diff changed since the selection: it no longer fits and is dropped.
      if (result.error.code === "stale_state") patch(tabId, { stashSelection: null });
      return;
    }
    patch(tabId, { stashMessage: "", stashOnlySelected: false, stashSelection: null });
    useWipStore.getState().clearSelection(tabId);
    void queryClient.invalidateQueries({ queryKey: qk.status(repoId) });
    back();
  };

  return (
    <form
      aria-label={t("stash.create")}
      className="flex shrink-0 flex-col gap-2 border-t border-border p-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <TextField
        id={nameId}
        label={t("stash.name.label")}
        placeholder={t("stash.name.placeholder")}
        hint={t("stash.name.hint")}
        value={wip.stashMessage}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        onChange={(event) => patch(tabId, { stashMessage: event.target.value.replace(/[\r\n]+/g, " ") })}
      />
      <div className="flex flex-col gap-1">
        {pending && counts ? (
          <Checkbox
            label={t("partialStash.only", { files: t("partialStash.files", { count: counts.files }), lines: t("partialStash.lines", { count: counts.lines }) })}
            checked
            hint={t("partialStash.onlyHint")}
            onCheckedChange={(checked) => {
              if (!checked) patch(tabId, { stashSelection: null });
            }}
          />
        ) : null}
        <Checkbox label={t("stash.includeUntracked")} checked={wip.stashUntracked} onCheckedChange={(checked) => patch(tabId, { stashUntracked: checked })} />
        <Checkbox
          label={marked.length > 0 ? t("stash.onlyMarkedCount", { count: marked.length }) : t("stash.onlyMarked")}
          checked={onlyMarked}
          disabled={marked.length === 0 || Boolean(pending)}
          hint={marked.length === 0 ? t("stash.onlyMarkedHint") : undefined}
          onCheckedChange={(checked) => patch(tabId, { stashOnlySelected: checked })}
        />
      </div>
      <div className="flex gap-2">
        <Button size="lg" variant="ghost" icon={<ArrowLeft className="size-icon" aria-hidden />} onClick={back}>
          {t("stash.backToCommit")}
        </Button>
        <Tip side="top" label={plan.blocked ?? (pending ? t("partialStash.create") : plan.paths ? t("stash.tipMarked") : t("stash.tipAll"))}>
          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={busy}
            icon={<Archive className="size-icon" aria-hidden />}
            data-action="stash"
            data-blocked={plan.blocked ? "" : undefined}
            {...(plan.blocked ? { "aria-disabled": true } : {})}
            className="min-w-0 flex-1 data-[blocked]:cursor-default data-[blocked]:bg-surface-raised data-[blocked]:text-text-disabled data-[blocked]:hover:brightness-100"
          >
            <span className="truncate">{plan.label}</span>
          </Button>
        </Tip>
      </div>
    </form>
  );
}

/** Create a named stash; replaces the commit form in the commit panel, the file lists stay. */
export function StashForm({ repoId, tabId }: StashFormProps) {
  return <ChangesPanel repoId={repoId} tabId={tabId} mode="stash" footer={<StashFields repoId={repoId} tabId={tabId} />} />;
}
