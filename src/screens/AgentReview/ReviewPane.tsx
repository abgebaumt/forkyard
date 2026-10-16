/**
 * One agent in the review: what it is compared against, the switch “Working state | Commits only”,
 * the notice when the agent continued (the selection stays on the pinned state until “Reload”), the
 * files “Selected / Not selected” and the diff of the active file with line check marks.
 * Keys in the lists: ↑/↓ choose a file, Space selects or deselects it, Enter puts the focus into the diff.
 */
import { useEffect, useRef } from "react";
import type { Agent, AgentReviewSource, FileChange, Id } from "../../core";
import { toCoreError } from "../../app/errors";
import { useAgentReview, useCommitDetails } from "../../app/queries";
import { FileList, type FileSelectModifiers } from "../../components/FileList";
import { Button } from "../../ui/Button";
import { Banner, EmptyState } from "../../ui/Feedback";
import { SegmentedControl } from "../../ui/Field";
import { cn } from "../../ui/cn";
import { t } from "../../i18n";
import { notPickable, rangeSource, splitFiles, toggleFile, withLines } from "./model";
import { ReviewDiff } from "./ReviewDiff";
import { ReviewActions } from "./ReviewActions";
import { initPicks, pin, usePane, useReviewStore } from "./state";

const TOGGLE = "inline-flex h-5 items-center rounded-sm border border-border bg-surface-raised px-1.5 text-xs font-medium text-text hover:border-border-input";

export function ReviewPane({ repoId, tabId, agent, compact }: { repoId: Id; tabId: Id; agent: Agent; compact: boolean }) {
  const pane = usePane(tabId, agent.id);
  const latest = useAgentReview(repoId, agent.id, pane.source);
  const pinned = pane.pinned;
  const details = useCommitDetails(repoId, pinned ? rangeSource(pinned) : null);
  const lists = useRef<HTMLDivElement>(null);
  const diffArea = useRef<HTMLDivElement>(null);
  const patch = useReviewStore.getState().patch;

  // The first answer is pinned; later ones only show the notice below.
  useEffect(() => {
    if (latest.data && !pinned) pin(tabId, agent.id, latest.data);
  }, [latest.data, pinned, tabId, agent.id]);
  useEffect(() => {
    if (details.data && pinned && !pane.picks) initPicks(tabId, agent.id, details.data.files);
  }, [details.data, pinned, pane.picks, tabId, agent.id]);

  const files = details.data?.files ?? [];
  const picks = pane.picks ?? {};
  const { chosen, rest } = splitFiles(files, picks);
  const stale = Boolean(latest.data && pinned && (latest.data.to !== pinned.to || latest.data.from !== pinned.from));
  const leftOut = pinned?.source === "branch" ? (latest.data?.uncommittedFiles ?? 0) : 0;
  const active = files.find((file) => file.path === pane.active) ?? null;

  const toggle = (file: FileChange) => patch(tabId, agent.id, (current) => ({ picks: toggleFile(current.picks ?? {}, file) }));
  const onSelect = (path: string, modifiers: FileSelectModifiers) => {
    const file = files.find((item) => item.path === path);
    if (!file) return;
    // Space arrives as an "additive" keyboard selection: it selects or deselects the file.
    if (modifiers.source === "keyboard" && modifiers.additive && !modifiers.range) {
      toggle(file);
      // The row moves to the other list; the keyboard focus moves with it instead of falling to the page.
      requestAnimationFrame(() => [...(lists.current?.querySelectorAll<HTMLElement>("[data-row-key]") ?? [])].find((row) => row.dataset.rowKey === path)?.focus());
    } else patch(tabId, agent.id, { active: path });
  };
  const focusDiff = (file: FileChange) => {
    patch(tabId, agent.id, { active: file.path });
    requestAnimationFrame(() => diffArea.current?.querySelector<HTMLElement>('[data-row][tabindex="0"], [role="grid"]')?.focus());
  };
  const focusLists = () => requestAnimationFrame(() => lists.current?.querySelector<HTMLElement>('[role="option"][tabindex="0"], [role="listbox"]')?.focus());
  const detail = (file: FileChange) => notPickable(file) ?? (picks[file.path]?.kind === "lines" ? t("agents.review.someLines") : null);
  const toggleButton = (file: FileChange, selected: boolean) =>
    notPickable(file) !== null ? null : (
      <button
        type="button"
        tabIndex={-1}
        data-review-toggle={file.path}
        aria-label={selected ? t("agents.review.deselectFile", { path: file.path }) : t("agents.review.selectFile", { path: file.path })}
        className={TOGGLE}
        onClick={(event) => {
          event.stopPropagation();
          toggle(file);
        }}
      >
        {selected ? t("agents.review.deselect") : t("agents.review.select")}
      </button>
    );

  return (
    <div data-review-pane={agent.id} onFocusCapture={() => useReviewStore.getState().setFocus(tabId, agent.id)} className="flex min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-surface px-3 py-1.5">
        <span className="min-w-0 truncate font-mono text-code text-text">{agent.branch}</span>
        <span className="text-sm text-text-muted">{t("agents.review.against", { base: agent.base })}</span>
        <span className="flex-1" />
        <SegmentedControl<AgentReviewSource>
          label={t("agents.review.source")}
          value={pane.source}
          onValueChange={(source) => patch(tabId, agent.id, { source, pinned: null, picks: null, active: null })}
          options={[
            { value: "snapshot", label: t("agents.review.sourceSnapshot") },
            { value: "branch", label: t("agents.review.sourceBranch") },
          ]}
        />
      </div>
      {latest.isError ? (
        <Banner tone="danger" title={t("agents.review.loadFailed")}>
          {toCoreError(latest.error).message}
        </Banner>
      ) : null}
      {stale && latest.data ? (
        <Banner
          tone="warning"
          title={t("agents.review.staleTitle")}
          actions={
            <Button size="sm" data-action="review-reload" onClick={() => latest.data && pin(tabId, agent.id, latest.data)}>
              {t("agents.review.reload")}
            </Button>
          }
        >
          {t("agents.review.staleBody")}
        </Banner>
      ) : null}
      {leftOut > 0 ? <Banner tone="info" title={t("agents.review.uncommittedLeftOut", { count: leftOut })} /> : null}
      <div className={cn("flex min-h-0 flex-1", compact ? "flex-col" : "flex-row")}>
        <div ref={lists} className={cn("flex min-h-0 shrink-0 flex-col overflow-auto border-border bg-surface", compact ? "basis-2/5 border-b" : "w-2/5 border-r")}>
          <section data-review-list="chosen" aria-label={t("agents.review.chosenList")}>
            <h2 className="px-3 pt-2 pb-1 text-sm font-semibold text-text">{t("agents.review.chosen", { count: chosen.length })}</h2>
            <FileList
              ariaLabel={t("agents.review.chosenList")}
              files={chosen}
              loading={Boolean(pinned) && details.isPending}
              selected={active && picks[active.path] ? [active.path] : []}
              onSelect={onSelect}
              onActivate={focusDiff}
              rowAction={(file) => toggleButton(file, true)}
              detail={detail}
              empty={t("agents.review.chosenEmpty")}
            />
          </section>
          <section data-review-list="rest" aria-label={t("agents.review.restList")}>
            <h2 className="px-3 pt-3 pb-1 text-sm font-semibold text-text">{t("agents.review.rest", { count: rest.length })}</h2>
            <FileList
              ariaLabel={t("agents.review.restList")}
              files={rest}
              selected={active && !picks[active.path] ? [active.path] : []}
              onSelect={onSelect}
              onActivate={focusDiff}
              rowAction={(file) => toggleButton(file, false)}
              detail={detail}
              empty={t("agents.review.restEmpty")}
            />
          </section>
        </div>
        <div ref={diffArea} className="flex min-h-0 min-w-0 flex-1 flex-col">
          {active && pinned ? (
            <ReviewDiff
              repoId={repoId}
              path={active.path}
              source={rangeSource(pinned)}
              pick={picks[active.path]}
              onKeys={(keys, diff) => patch(tabId, agent.id, (current) => ({ picks: withLines(current.picks ?? {}, active.path, keys, diff) }))}
              onLeave={focusLists}
            />
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <EmptyState title={t("agents.review.pickFile")} />
            </div>
          )}
        </div>
      </div>
      <ReviewActions repoId={repoId} tabId={tabId} agent={agent} latest={latest.data ?? null} chosen={chosen.length} />
    </div>
  );
}
