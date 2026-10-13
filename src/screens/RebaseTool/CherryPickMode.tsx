/**
 * Cherry-pick of several commits: list in the order they are applied (reorderable, individual
 * ones can be deselected); the target is the checked-out branch.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, Cherry, GripVertical } from "lucide-react";
import { core, type Id, type Sha } from "../../core";
import { graphIndex, isAncestor, oldestFirst } from "../../app/actions/ancestry";
import { busyKeys } from "../../app/actions/keys";
import { operationNames, reportOpResult } from "../../app/actions/merge";
import { shortSha } from "../../app/format";
import { useSettings, useStatus } from "../../app/queries";
import { runAction } from "../../app/run";
import { withFreshStatus } from "../../app/statusCache";
import { useBusy } from "../../app/store";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { toast } from "../../ui/Feedback";
import { Tip } from "../../ui/Tooltip";
import { moveItem } from "./model";
import { ColumnBar, CommitCells, LoadError, Name, SkeletonRows, StartButton, StatePanel, ToolFooter, ToolHeader, type StartRef } from "./parts";
import { ReorderList } from "./ReorderList";
import { useCommitRows } from "./useCommitRows";
import { t } from "../../i18n";

export function CherryPickMode({ repoId, tabId, shas, onClose, startRef }: { repoId: Id; tabId: Id; shas: Sha[]; onClose: () => void; startRef: StartRef }) {
  startRef.current = null;
  const unique = useMemo(() => [...new Set(shas)], [shas]);
  const { pending, error, commits, retry } = useCommitRows(repoId, unique);
  const { data: status } = useStatus(repoId);
  const { data: settings } = useSettings();
  const busy = useBusy(busyKeys.history(repoId));
  // Initial order: as in the history, oldest first. After that the user decides.
  const [order, setOrder] = useState<Sha[]>(() => oldestFirst(graphIndex(repoId), unique));
  const [excluded, setExcluded] = useState<Set<Sha>>(() => new Set());
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const bySha = useMemo(() => new Map(commits.map((commit) => [commit.sha, commit])), [commits]);
  const ready = !pending && !error && bySha.size > 0;
  useEffect(() => {
    if (ready) listRef.current?.focus({ preventScroll: true });
  }, [ready]);

  const head = status?.head;
  const headSha = head && head.kind !== "unborn" ? head.sha : null;
  const index = graphIndex(repoId);
  const contained = (sha: Sha) => (index && headSha ? isAncestor(index, sha, headSha) === true : false);
  const target = head?.kind === "branch" ? <Name>{head.branch}</Name> : head?.kind === "detached" ? <Name mono>HEAD {shortSha(head.sha)}</Name> : null;
  const targetText = head?.kind === "branch" ? t("rebase.pick.branchQuoted", { branch: head.branch }) : head?.kind === "detached" ? `HEAD (${shortSha(head.sha)})` : "HEAD";

  const header = (
    <ToolHeader
      icon={<Cherry className="size-icon" aria-hidden />}
      title={t("rebase.tool.cherryPick")}
      onClose={onClose}
      subtitle={
        <>
          <span className="shrink-0">{t("rebase.commits", { count: unique.length })}</span>
          {target ? (
            <>
              <span className="shrink-0">{t("rebase.pick.to")}</span>
              {target}
            </>
          ) : null}
        </>
      }
    />
  );

  if (unique.length === 0) {
    return (
      <>
        {header}
        <StatePanel state="empty" icon={<Cherry className="size-8" aria-hidden />} title={t("rebase.pick.noneTitle")} actions={<Button onClick={onClose}>{t("rebase.backToGraph")}</Button>}>
          {t("rebase.pick.noneBody")}
        </StatePanel>
      </>
    );
  }
  if (pending) {
    return (
      <>
        {header}
        <ColumnBar direction={t("rebase.pick.order")} lead={<span className="w-14 shrink-0" />} />
        <SkeletonRows rows={Math.min(unique.length, 8)} />
      </>
    );
  }
  if (error) {
    return (
      <>
        {header}
        <LoadError error={error} icon={<Cherry className="size-8" aria-hidden />} onRetry={retry} onClose={onClose} />
      </>
    );
  }

  const rows = order.filter((sha) => bySha.has(sha));
  const chosen = rows.filter((sha) => !excluded.has(sha));
  const toggle = (sha: Sha) =>
    setExcluded((set) => {
      const next = new Set(set);
      if (next.has(sha)) next.delete(sha);
      else next.add(sha);
      return next;
    });

  const blocked = busy
    ? null
    : head?.kind === "unborn"
      ? t("rebase.pick.unborn")
      : status?.operation
        ? t("rebase.pick.operationRunning", { operation: operationNames[status.operation.kind] })
        : chosen.length === 0
          ? t("rebase.pick.chooseOne")
          : null;

  const start = async () => {
    if (blocked || busy) return;
    const label = chosen.length === 1 ? t("rebase.tool.cherryPick") : t("rebase.pick.labelMany", { count: chosen.length });
    const result = await runAction(label, withFreshStatus(repoId, () => core.cherryPick({ repoId, shas: chosen })), { busyKey: busyKeys.history(repoId) });
    if (!result.ok) return;
    if (result.value.status === "up_to_date") {
      toast({ tone: "info", title: t("rebase.pick.upToDateTitle"), description: t("rebase.pick.upToDateBody", { target: targetText }) });
      return;
    }
    onClose();
    reportOpResult(label, result.value, tabId, { reveal: true });
  };

  startRef.current = () => void start();

  const onKey = (event: KeyboardEvent, position: number) => {
    if (event.key === " " && !event.altKey && !event.shiftKey) {
      const sha = rows[position];
      if (sha) toggle(sha);
      return true;
    }
    return false;
  };

  return (
    <>
      {header}
      <ColumnBar direction={t("rebase.pick.orderOnto", { target: targetText })} lead={<span className="w-14 shrink-0" />} />
      <div className="min-h-0 flex-1">
        <ReorderList
          listRef={listRef}
          count={rows.length}
          getKey={(position) => rows[position]!}
          active={active}
          onActiveChange={setActive}
          ariaLabel={t("rebase.pick.listLabel")}
          describedBy="s14-pick-keys"
          isSelected={(position) => !excluded.has(rows[position]!)}
          reorderable
          onMove={(from, to) => setOrder(moveItem(rows, from, to))}
          onKey={onKey}
          onActivate={(position) => toggle(rows[position]!)}
          dragLabel={(position) => bySha.get(rows[position]!)?.summary ?? ""}
          rowLabel={(position) => {
            const commit = bySha.get(rows[position]!)!;
            return `${excluded.has(commit.sha) ? t("rebase.pick.skipped") : t("rebase.pick.step", { step: chosen.indexOf(commit.sha) + 1 })}: ${commit.summary}, ${commit.author.name}, ${shortSha(commit.sha)}${contained(commit.sha) ? `, ${t("rebase.pick.alreadyIn", { target: targetText })}` : ""}`;
          }}
          renderRow={(position) => {
            const commit = bySha.get(rows[position]!)!;
            const off = excluded.has(commit.sha);
            const step = chosen.indexOf(commit.sha) + 1;
            return (
              <div className="flex min-w-0 flex-1 items-center gap-2 pr-3" data-included={off ? "false" : "true"}>
                <span aria-hidden className="flex w-6 shrink-0 cursor-grab justify-center text-text-muted" title={t("rebase.dragToReorder")}>
                  <GripVertical className="size-icon" />
                </span>
                <button
                  type="button"
                  tabIndex={-1}
                  data-no-drag=""
                  role="checkbox"
                  aria-checked={!off}
                  aria-label={off ? t("rebase.pick.include") : t("rebase.pick.exclude")}
                  onClick={() => {
                    setActive(position);
                    toggle(commit.sha);
                  }}
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-sm border",
                    off ? "border-border-input bg-surface-sunken" : "border-accent bg-accent text-on-accent",
                  )}
                >
                  {off ? null : <Check className="size-3" aria-hidden />}
                </button>
                <span aria-hidden className="w-4 shrink-0 text-right font-mono text-xs text-text-muted">
                  {off ? "–" : step}
                </span>
                <span className={cn("min-w-0 flex-1 truncate", off ? "text-text-muted line-through opacity-60" : "text-text")} data-summary="">
                  {commit.summary}
                </span>
                {contained(commit.sha) ? (
                  <Tip label={t("rebase.pick.containedTip", { target: targetText })}>
                    <span className="shrink-0 rounded-sm border border-border px-1 text-xs text-text-muted">{t("rebase.pick.contained")}</span>
                  </Tip>
                ) : null}
                <CommitCells authorName={commit.author.name} authorEmail={commit.author.email} authoredAt={commit.authoredAt} sha={commit.sha} dateFormat={settings?.dateFormat ?? "relative"} dimmed={off} />
              </div>
            );
          }}
        />
      </div>
      <span id="s14-pick-keys" className="sr-only">
        {t("rebase.pick.keysHelp")}
      </span>
      <ToolFooter
        keys={[
          [t("rebase.keys.spaceKey"), t("rebase.pick.keyToggle")],
          ["Alt+↑ Alt+↓", t("rebase.keys.move")],
          ["Mod+Enter", t("rebase.keys.start")],
        ]}
        info={
          <span className="flex min-w-0 items-center gap-1.5" role="status">
            <span className="shrink-0 font-medium">
              {chosen.length === rows.length ? t("rebase.commits", { count: rows.length }) : t("rebase.pick.chosenOf", { chosen: chosen.length, count: rows.length })}
            </span>
            <span className="truncate text-text-muted">· {t("rebase.pick.footer", { target: targetText })}</span>
          </span>
        }
      >
        <Button variant="ghost" onClick={onClose}>
          {t("rebase.cancel")}
        </Button>
        <StartButton
          action="start"
          label={t("rebase.pick.start", { count: chosen.length })}
          blocked={blocked}
          loading={busy}
          icon={<Cherry className="size-icon" aria-hidden />}
          onClick={() => void start()}
        />
      </ToolFooter>
    </>
  );
}
