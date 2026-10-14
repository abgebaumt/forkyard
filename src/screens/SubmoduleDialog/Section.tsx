/**
 * "Submodules" section in the left panel: every submodule with its state as a word and an icon
 * (initialised, not initialised, out of sync, modified). Enter opens it as a repository.
 * If submodules have not been fetched yet, the section offers to initialise them.
 */
import { useEffect, type ReactNode } from "react";
import { Copy, Download, FolderInput, GitCompareArrows, Info, Loader2, PackageCheck, PackageOpen, PencilLine, Plus, RefreshCw, SquareArrowOutUpRight, Trash2 } from "lucide-react";
import type { Id, Submodule, SubmoduleState } from "../../core";
import { copyText } from "../../app/actions/clipboard";
import { moveSubmodule, openSubmodule, removeSubmodule, submoduleBusyKey, submoduleStateText, updateSubmodules } from "../../app/actions/submodules";
import { qk, queryClient, useSubmodules, useViewState } from "../../app/queries";
import { useAppStore, useBusy } from "../../app/store";
import { Marked, MENU_SEPARATOR, menuItem, SideEmpty, SideLoadError, SideSection, SideSkeleton, type SideRowState } from "../../components/SideSection";
import { Button, IconButton } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { toast } from "../../ui/Feedback";
import { TreeRow } from "../../ui/Git";
import type { MenuEntry } from "../../ui/Menu";
import { t } from "../../i18n";
import { EMPTY_VIEW, sectionState, setSection } from "../LeftPanel/viewState";
import { describeSubmodule, matchesSubmodule, splitPath, submoduleSecondary, submoduleTipLines } from "./model";

export interface SubmodulesSectionProps {
  repoId: Id;
  tabId: Id;
  /** Text of the panel's filter bar. */
  query: string;
}

const stateIcon: Record<SubmoduleState, typeof PackageCheck> = {
  initialized: PackageCheck,
  uninitialized: PackageOpen,
  out_of_sync: GitCompareArrows,
  modified: PencilLine,
};

const openAddDialog = () => useAppStore.getState().openOverlay({ kind: "add_submodule" });

// ---------------------------------------------------------------------------
// Offer after cloning: once per repository as a toast, afterwards only the hint in the section
// ---------------------------------------------------------------------------

const OFFER_KEY = "gc.submoduleOffer";

function offeredBefore(repoId: Id): boolean {
  try {
    return (JSON.parse(localStorage.getItem(OFFER_KEY) ?? "[]") as string[]).includes(repoId);
  } catch {
    return false;
  }
}

function rememberOffer(repoId: Id): void {
  try {
    const known = JSON.parse(localStorage.getItem(OFFER_KEY) ?? "[]") as string[];
    if (!known.includes(repoId)) localStorage.setItem(OFFER_KEY, JSON.stringify([...known, repoId].slice(-200)));
  } catch {
    // without localStorage the offer appears once more on the next start
  }
}

function offerInit(repoId: Id, pending: Submodule[]): void {
  if (pending.length === 0 || offeredBefore(repoId)) return;
  rememberOffer(repoId);
  toast({
    tone: "info",
    title: t("submodules.offer.title", { count: pending.length }),
    description: t("submodules.offer.description", {
      count: pending.length,
      paths: `${pending
        .slice(0, 3)
        .map((item) => item.path)
        .join(", ")}${pending.length > 3 ? " …" : ""}`,
    }),
    action: { label: t("submodules.offer.action"), onClick: () => void updateSubmodules(repoId, null, { init: true }) },
  });
}

// ---------------------------------------------------------------------------

function submoduleMenu(repoId: Id, submodule: Submodule, busy: boolean): MenuEntry[] {
  const fresh = submodule.state === "uninitialized";
  const running = busy ? t("submodules.menu.busy") : null;
  return [
    fresh
      ? menuItem(t("submodules.menu.init"), Download, () => void updateSubmodules(repoId, [submodule], { init: true }), { hint: running ? undefined : t("submodules.menu.initHint"), blocked: running })
      : menuItem(t("submodules.menu.update"), RefreshCw, () => void updateSubmodules(repoId, [submodule], { init: true }), {
          hint: running ? undefined : submodule.state === "initialized" ? t("submodules.menu.upToDate") : t("submodules.menu.updateHint"),
          blocked: running,
        }),
    menuItem(t("submodules.menu.open"), SquareArrowOutUpRight, () => void openSubmodule(repoId, submodule), { shortcut: "Enter", blocked: fresh ? t("submodules.menu.initFirst") : null }),
    MENU_SEPARATOR,
    menuItem(t("submodules.menu.copyUrl"), Copy, () => void copyText(submodule.url ?? "", t("submodules.menu.urlWhat")), { blocked: submodule.url ? null : t("submodules.menu.noUrl") }),
    menuItem(t("submodules.menu.copyPath"), Copy, () => void copyText(submodule.path, t("submodules.menu.pathWhat"))),
    menuItem(t("submoduleMove.menu"), FolderInput, () => void moveSubmodule(repoId, submodule), { tooltip: t("submoduleMove.menuTip", { path: submodule.path }), blocked: running }),
    MENU_SEPARATOR,
    menuItem(t("submodules.menu.updateAll"), RefreshCw, () => void updateSubmodules(repoId, null, { init: true }), { blocked: running }),
    menuItem(t("submodules.menu.add"), Plus, openAddDialog),
    MENU_SEPARATOR,
    menuItem(t("submodules.menu.remove"), Trash2, () => void removeSubmodule(repoId, submodule), { shortcut: "Delete", danger: true, tooltip: t("submodules.menu.removeTip", { path: submodule.path }), blocked: running }),
  ];
}

function SubmoduleRow({ repoId, submodule, state, query, busy }: { repoId: Id; submodule: Submodule; state: SideRowState; query: string; busy: boolean }) {
  const { name, dir } = splitPath(submodule.path);
  const lines = submoduleTipLines(submodule);
  const Icon = stateIcon[submodule.state];
  const fresh = submodule.state === "uninitialized";
  const warn = submodule.state === "out_of_sync" || submodule.state === "modified";
  return (
    <TreeRow
      {...state.attrs}
      label={name}
      labelContent={
        <>
          <Marked text={name} query={query} />
          {dir ? <span className="ml-1.5 text-sm font-normal text-text-muted">{dir}</span> : null}
        </>
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
      secondary={submoduleSecondary(submodule)}
      icon={<Icon className={cn("size-3.5", warn && "text-warning")} aria-hidden />}
      selected={state.selected}
      focusable={state.focusable}
      hidden={fresh}
      trailing={
        <IconButton
          size="sm"
          tabIndex={-1}
          data-action={fresh ? "init" : "update"}
          disabled={busy}
          label={fresh ? t("submodules.menu.init") : t("submodules.menu.update")}
          icon={fresh ? <Download className="size-3.5" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />}
          onClick={(event) => {
            event.stopPropagation();
            void updateSubmodules(repoId, [submodule], { init: true });
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        />
      }
      aria-label={describeSubmodule(submodule)}
      data-kind="submodule"
      data-state={submodule.state}
      className="scroll-mt-control-md"
    />
  );
}

/** "Submodules" section – sits below the ref sections of the left panel. */
export function SubmodulesSection({ repoId, query }: SubmodulesSectionProps) {
  const submodules = useSubmodules(repoId);
  const viewQuery = useViewState(repoId);
  const view = viewQuery.data ?? EMPTY_VIEW;
  const state = sectionState(view, "submodules");
  const busy = useBusy(submoduleBusyKey(repoId));

  // Work in a submodule happens in another tab or program: refetch when coming back.
  useEffect(() => {
    const onFocus = () => void queryClient.invalidateQueries({ queryKey: qk.submodules(repoId) });
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [repoId]);

  const all = submodules.data ?? [];
  const pending = all.filter((item) => item.state === "uninitialized");
  const pendingKey = pending.map((item) => item.path).join("\n");
  useEffect(() => {
    if (pendingKey) offerInit(repoId, pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, pendingKey]);

  if (state.hidden) return null;

  const filtering = query.trim().length > 0;
  const items = filtering ? all.filter((item) => matchesSubmodule(item, query)) : all;
  // While filtering only what has a match stays.
  if (filtering && items.length === 0) return null;

  const open = filtering ? true : !state.collapsed;
  const toggle = () => {
    if (filtering || !viewQuery.data) return;
    void setSection(repoId, "submodules", { collapsed: !state.collapsed });
  };
  const updateAll = () => void updateSubmodules(repoId, null, { init: true });

  let placeholder: ReactNode = undefined;
  if (submodules.isPending) placeholder = <SideSkeleton rows={1} />;
  else if (submodules.isError && !submodules.data) placeholder = <SideLoadError title={t("submodules.section.loadError")} error={submodules.error} onRetry={() => void submodules.refetch()} />;
  else if (all.length === 0) {
    placeholder = (
      <SideEmpty
        action={
          <Button size="sm" variant="ghost" onClick={openAddDialog}>
            {t("submodules.section.add")}
          </Button>
        }
      >
        {t("submodules.section.empty")}
      </SideEmpty>
    );
  }

  const notice =
    pending.length > 0 && !filtering && !placeholder ? (
      <div role="status" data-submodule-hint className="mx-2 mb-1 flex items-center gap-1.5 rounded-md bg-accent-surface py-0.5 pr-0.5 pl-2 text-sm">
        <Info className="size-3.5 shrink-0 text-accent" aria-hidden />
        <span className="min-w-0 flex-1 truncate" title={t("submodules.section.pendingTip", { count: pending.length })}>
          {t("submodules.section.pending", { count: pending.length })}
        </span>
        <Button size="sm" variant="ghost" loading={busy} onClick={() => void updateSubmodules(repoId, pending, { init: true })}>
          {t("submodules.menu.init")}
        </Button>
      </div>
    ) : null;

  const noneBlock = all.length === 0 ? t("submodules.section.none") : busy ? t("submodules.section.running") : null;
  const sectionMenu: MenuEntry[] = [
    menuItem(open ? t("submodules.section.collapse") : t("submodules.section.expand"), null, toggle, { blocked: filtering ? t("submodules.section.alwaysOpen") : null }),
    menuItem(t("submodules.section.hide"), null, () => void setSection(repoId, "submodules", { hidden: true }), { hint: t("submodules.section.hideHint") }),
    MENU_SEPARATOR,
    menuItem(t("submodules.menu.add"), Plus, openAddDialog),
    menuItem(t("submodules.menu.updateAll"), RefreshCw, updateAll, { blocked: noneBlock }),
  ];

  const states = all.reduce<Partial<Record<SubmoduleState, number>>>((sum, item) => ({ ...sum, [item.state]: (sum[item.state] ?? 0) + 1 }), {});
  const summary = (Object.keys(states) as SubmoduleState[]).map((key) => `${states[key]} ${submoduleStateText[key]}`).join(", ");

  return (
    <SideSection
      id="submodules"
      title={t("submodules.section.title")}
      icon={<PackageOpen aria-hidden />}
      count={submodules.isPending ? undefined : filtering ? `${items.length}/${all.length}` : all.length}
      open={open}
      onToggle={toggle}
      listLabel={summary ? t("submodules.section.listLabel", { summary }) : t("submodules.section.title")}
      items={items}
      itemId={(item) => item.path}
      itemText={(item) => splitPath(item.path).name}
      renderRow={(item, rowState) => <SubmoduleRow key={item.path} repoId={repoId} submodule={item} state={rowState} query={query} busy={busy} />}
      onActivate={(item) => void openSubmodule(repoId, item)}
      onRemove={(item) => void removeSubmodule(repoId, item)}
      rowMenu={(item) => submoduleMenu(repoId, item, busy)}
      sectionMenu={sectionMenu}
      notice={notice}
      placeholder={placeholder}
      actions={
        <>
          {all.length > 0 ? (
            <IconButton size="sm" tabIndex={-1} data-action="update-all" label={t("submodules.menu.updateAll")} disabled={busy} icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={updateAll} />
          ) : null}
          <IconButton size="sm" data-action="add" label={t("submodules.dialog.title")} icon={<Plus className="size-3.5" aria-hidden />} onClick={openAddDialog} />
        </>
      }
      pinnedActions={
        busy ? (
          <span role="status" className="inline-flex size-control-sm items-center justify-center text-text-muted" data-submodule-busy>
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            <span className="sr-only">{t("submodules.section.fetching")}</span>
          </span>
        ) : undefined
      }
    />
  );
}
