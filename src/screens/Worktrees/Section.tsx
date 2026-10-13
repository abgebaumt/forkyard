/**
 * "Worktrees" section in the left panel: all working folders of the repository. The main folder and
 * the one opened here are marked, locked ones state their reason, orphaned ones (folder missing) can
 * be pruned. Enter opens the worktree in a tab.
 */
import { useEffect, type ReactNode } from "react";
import { Copy, Eraser, FolderGit2, FolderLock, FolderX, Loader2, Lock, LockOpen, PencilLine, Plus, SquareArrowOutUpRight, Trash2, TriangleAlert } from "lucide-react";
import type { Id, Worktree } from "../../core";
import { copyText } from "../../app/actions/clipboard";
import { folderName, lockWorktree, openWorktree, pruneWorktrees, removeBlock, removeWorktree, unlockWorktree, worktreeBusyKey } from "../../app/actions/worktrees";
import { qk, queryClient, useViewState, useWorktrees } from "../../app/queries";
import { useBusy } from "../../app/store";
import { Marked, MENU_SEPARATOR, menuItem, SideEmpty, SideLoadError, SideSection, SideSkeleton, type SideRowState } from "../../components/SideSection";
import { Button, IconButton } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { TreeRow } from "../../ui/Git";
import type { MenuEntry } from "../../ui/Menu";
import { Tip } from "../../ui/Tooltip";
import { t } from "../../i18n";
import { EMPTY_VIEW, sectionState, setSection } from "../LeftPanel/viewState";
import { askLockReason, openWorktreeDialog } from "./Dialog";
import { describeWorktree, matchesWorktree, sortWorktrees, splitFolderName, worktreeSecondary, worktreeTipLines } from "./model";

export interface WorktreesSectionProps {
  repoId: Id;
  tabId: Id;
  /** Text of the panel's filter bar. */
  query: string;
}

async function changeLock(repoId: Id, worktree: Worktree) {
  const answer = await askLockReason(worktree);
  if (answer) await lockWorktree(repoId, worktree, answer.reason || null);
}

function worktreeMenu(repoId: Id, worktree: Worktree, anyOrphans: boolean): MenuEntry[] {
  const name = folderName(worktree.path);
  const lockBlock = worktree.isMain ? t("worktrees.menu.mainNoLock") : null;
  return [
    menuItem(t("worktrees.dialog.openInTab"), SquareArrowOutUpRight, () => void openWorktree(worktree), {
      shortcut: "Enter",
      blocked: worktree.isPrunable ? t("worktrees.menu.folderMissing") : worktree.isCurrent ? t("worktrees.menu.alreadyOpen") : null,
    }),
    menuItem(t("worktrees.menu.copyPath"), Copy, () => void copyText(worktree.path, t("worktrees.menu.pathWhat"))),
    MENU_SEPARATOR,
    worktree.isLocked
      ? menuItem(t("worktrees.menu.unlock"), LockOpen, () => void unlockWorktree(repoId, worktree))
      : menuItem(t("worktrees.menu.lock"), Lock, () => void changeLock(repoId, worktree), { blocked: lockBlock, hint: lockBlock ? undefined : t("worktrees.menu.lockHint") }),
    worktree.isLocked ? menuItem(t("worktrees.menu.changeReason"), PencilLine, () => void changeLock(repoId, worktree)) : null,
    MENU_SEPARATOR,
    menuItem(t("worktrees.menu.create"), Plus, () => void openWorktreeDialog(repoId)),
    anyOrphans ? menuItem(t("worktrees.menu.pruneAll"), Eraser, () => void pruneWorktrees(repoId)) : null,
    MENU_SEPARATOR,
    worktree.isPrunable && !worktree.isLocked
      ? menuItem(t("worktrees.menu.pruneOne"), Eraser, () => void pruneWorktrees(repoId), { shortcut: "Delete", tooltip: t("worktrees.menu.pruneOneTip", { name }) })
      : menuItem(t("worktrees.menu.remove"), Trash2, () => void removeWorktree(repoId, worktree), { shortcut: "Delete", danger: true, tooltip: t("worktrees.menu.removeTip", { name }), blocked: removeBlock(worktree) }),
  ].filter((entry): entry is MenuEntry => entry !== null);
}

function WorktreeRow({ worktree, state, query, busy, repoName }: { worktree: Worktree; state: SideRowState; query: string; busy: boolean; repoName: string }) {
  const name = folderName(worktree.path);
  // The prefix shared by all folders is only there for screen readers (full path in the tooltip); while filtering the name stays whole so the match is right.
  const [prefix, rest] = query.trim() ? ["", name] : splitFolderName(name, repoName);
  const detail = worktree.isLocked && worktree.lockReason && !worktree.isPrunable ? `${worktreeSecondary(worktree)}: ${worktree.lockReason}` : worktreeSecondary(worktree);
  const lines = worktreeTipLines(worktree);
  const Icon = worktree.isPrunable ? FolderX : worktree.isLocked ? FolderLock : FolderGit2;
  const flags = (
    // Fills the rest of the row (right-aligned): truncation happens only when name and details together don't fit.
    <span className="inline-flex min-w-12 flex-1 items-center justify-end gap-1">
      <span className="min-w-0 truncate text-xs text-text-muted" data-worktree-detail>
        {detail}
      </span>
      {worktree.hasChanges && !worktree.isPrunable ? (
        <Tip label={t("worktrees.tip.changes")} side="right">
          <span className="inline-flex size-1.5 shrink-0 rounded-full bg-warning" data-flag="changed" aria-hidden />
        </Tip>
      ) : null}
      {worktree.isPrunable ? (
        <Tip label={t("worktrees.tip.orphanFlag")} side="right">
          <span className="inline-flex items-center text-warning" data-flag="orphan">
            <TriangleAlert className="size-3.5" aria-hidden />
          </span>
        </Tip>
      ) : null}
      {worktree.isLocked ? (
        <Tip label={worktree.lockReason ? t("worktrees.tip.lockedReason", { reason: worktree.lockReason }) : t("worktrees.tip.lockedNoReason")} side="right">
          <span className="inline-flex items-center text-text-muted" data-flag="locked">
            <Lock className="size-3.5" aria-hidden />
          </span>
        </Tip>
      ) : null}
    </span>
  );
  return (
    <TreeRow
      {...state.attrs}
      label={name}
      labelContent={
        prefix ? (
          <>
            <span className="sr-only">{prefix}</span>
            {rest}
          </>
        ) : (
          <Marked text={name} query={query} />
        )
      }
      tip={
        <span className="flex flex-col gap-0.5">
          {lines.map((line, index) => (
            <span key={index} className={cn("break-all whitespace-pre-line", index > 0 && "text-text-muted")}>
              {line}
            </span>
          ))}
        </span>
      }
      icon={busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Icon className={cn("size-3.5", worktree.isPrunable && "text-warning")} aria-hidden />}
      active={worktree.isCurrent}
      selected={state.selected}
      focusable={state.focusable}
      hidden={worktree.isPrunable}
      meta={flags}
      metaFills
      trailing={
        worktree.isCurrent || worktree.isPrunable ? undefined : (
          <IconButton
            size="sm"
            tabIndex={-1}
            data-action="open"
            label={t("worktrees.dialog.openInTab")}
            icon={<SquareArrowOutUpRight className="size-3.5" aria-hidden />}
            onClick={(event) => {
              event.stopPropagation();
              void openWorktree(worktree);
            }}
            onDoubleClick={(event) => event.stopPropagation()}
          />
        )
      }
      aria-label={describeWorktree(worktree)}
      data-kind="worktree"
      data-main={worktree.isMain ? "" : undefined}
      data-current={worktree.isCurrent ? "" : undefined}
      data-locked={worktree.isLocked ? "" : undefined}
      data-prunable={worktree.isPrunable ? "" : undefined}
      data-changed={worktree.hasChanges ? "" : undefined}
      className="scroll-mt-control-md"
    />
  );
}

/** "Worktrees" section – sits below the ref sections of the left panel. */
export function WorktreesSection({ repoId, query }: WorktreesSectionProps) {
  const worktrees = useWorktrees(repoId);
  const viewQuery = useViewState(repoId);
  const view = viewQuery.data ?? EMPTY_VIEW;
  const state = sectionState(view, "worktrees");
  const busy = useBusy(worktreeBusyKey(repoId));

  // The app does not watch other folders: refetch the state when coming back to the window.
  useEffect(() => {
    const onFocus = () => void queryClient.invalidateQueries({ queryKey: qk.worktrees(repoId) });
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [repoId]);

  if (state.hidden) return null;

  const all = worktrees.data ?? [];
  const filtering = query.trim().length > 0;
  const items = sortWorktrees(filtering ? all.filter((item) => matchesWorktree(item, query)) : all);
  const mainTree = all.find((item) => item.isMain);
  const repoName = mainTree ? folderName(mainTree.path) : "";
  // While filtering only what has a match stays.
  if (filtering && items.length === 0) return null;

  const orphans = all.filter((item) => item.isPrunable && !item.isLocked);
  const open = filtering ? true : !state.collapsed;
  const toggle = () => {
    if (filtering || !viewQuery.data) return;
    void setSection(repoId, "worktrees", { collapsed: !state.collapsed });
  };

  let placeholder: ReactNode = undefined;
  if (worktrees.isPending) placeholder = <SideSkeleton rows={1} />;
  else if (worktrees.isError && !worktrees.data) placeholder = <SideLoadError title={t("worktrees.section.loadError")} error={worktrees.error} onRetry={() => void worktrees.refetch()} />;
  else if (all.length === 0) {
    placeholder = (
      <SideEmpty
        action={
          <Button size="sm" variant="ghost" onClick={() => void openWorktreeDialog(repoId)}>
            {t("worktrees.section.create")}
          </Button>
        }
      >
        {t("worktrees.section.empty")}
      </SideEmpty>
    );
  }

  const sectionMenu: MenuEntry[] = [
    menuItem(open ? t("worktrees.section.collapse") : t("worktrees.section.expand"), null, toggle, { blocked: filtering ? t("worktrees.section.alwaysOpen") : null }),
    menuItem(t("worktrees.section.hide"), null, () => void setSection(repoId, "worktrees", { hidden: true }), { hint: t("worktrees.section.hideHint") }),
    MENU_SEPARATOR,
    menuItem(t("worktrees.menu.create"), Plus, () => void openWorktreeDialog(repoId)),
    menuItem(t("worktrees.menu.pruneAll"), Eraser, () => void pruneWorktrees(repoId), { blocked: orphans.length ? null : t("worktrees.section.noOrphans") }),
  ];

  return (
    <SideSection
      id="worktrees"
      title={t("worktrees.section.title")}
      count={worktrees.isPending ? undefined : filtering ? `${items.length}/${all.length}` : all.length}
      open={open}
      onToggle={toggle}
      listLabel={t("worktrees.section.title")}
      items={items}
      itemId={(item) => item.path}
      itemText={(item) => folderName(item.path)}
      renderRow={(item, rowState) => <WorktreeRow key={item.path} worktree={item} state={rowState} query={query} busy={false} repoName={repoName} />}
      onActivate={(item) => void openWorktree(item)}
      onRemove={(item) => void removeWorktree(repoId, item)}
      rowMenu={(item) => worktreeMenu(repoId, item, orphans.length > 0)}
      sectionMenu={sectionMenu}
      placeholder={placeholder}
      actions={<IconButton size="sm" data-action="add" label={t("worktrees.dialog.title")} icon={<Plus className="size-3.5" aria-hidden />} onClick={() => void openWorktreeDialog(repoId)} />}
      pinnedActions={
        busy || orphans.length ? (
          <>
            {busy ? (
              <span role="status" className="inline-flex size-control-sm items-center justify-center text-text-muted" data-worktree-busy>
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                <span className="sr-only">{t("worktrees.section.busy")}</span>
              </span>
            ) : null}
            {orphans.length ? (
              <IconButton
                size="sm"
                data-action="prune"
                label={t("worktrees.section.prune", { count: orphans.length })}
                disabled={busy}
                icon={<Eraser className="size-3.5 text-warning" aria-hidden />}
                onClick={() => void pruneWorktrees(repoId)}
              />
            ) : null}
          </>
        ) : undefined
      }
    />
  );
}
