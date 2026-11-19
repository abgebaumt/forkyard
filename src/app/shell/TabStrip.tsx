import { useEffect, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { PencilLine } from "lucide-react";
import { core, CoreError, type Tab } from "../../core";
import { TabBar, type RepoTab, type TabMenuActions } from "./Chrome";
import { toast } from "../../ui/Feedback";
import type { MenuEntry } from "../../ui/Menu";
import { openExternal } from "../actions/files";
import { openRepoCleanup } from "../../screens/RepoCleanup";
import { activateTab, closeOtherTabs, closeTab, moveTab, newTab } from "../actions/repos";
import { qk, useRepos, useWindows } from "../queries";
import { adoptArrivedTabs, dropTab, moveTabToNewWindow, moveTabToWindow, newWindow } from "../actions/windows";
import { commandShortcut } from "../registry";
import { readStatus } from "../statusOrder";
import { ProfileChip } from "./ProfileChip";
import { onTabRenameRequest, setTabAlias } from "./tabAlias";
import { t } from "../../i18n";
import { writeClipboard } from "../actions/clipboard";

/** Tab strip from the core's tab list: activate, close, drag, context menu, dot for changes. */
export function TabStrip({ tabs }: { tabs: Tab[] }) {
  const { data: repos } = useRepos();
  const { data: windows } = useWindows();
  // Tabs that arrive from another window bring their view state and terminals.
  const arrivals = tabs.map((tab) => `${tab.id}\t${tab.repoId ?? ""}`).join("\n");
  useEffect(() => {
    void adoptArrivedTabs(tabs);
    // Only a changed set of tabs counts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrivals]);
  // "Rename tab" from the Command Palette: the input opens on the tab, as with F2.
  const [renameRequest, setRenameRequest] = useState<{ id: string; nonce: number } | null>(null);
  useEffect(() => onTabRenameRequest((id) => setRenameRequest((previous) => ({ id, nonce: (previous?.nonce ?? 0) + 1 }))), []);
  const repoTabs = tabs.filter((tab) => tab.kind === "repo" && tab.repoId);
  const missing = new Set(repos?.filter((repo) => repo.missing).map((repo) => repo.id));
  // Locked (own commands, no consent yet): the core does not work there – nobody asks for the status.
  const locked = new Set(repos?.filter((repo) => repo.trusted === false).map((repo) => repo.id));

  // Status of every open repo for the "uncommitted changes" dot.
  const statuses = useQueries({
    queries: repoTabs.map((tab) => ({
      queryKey: qk.status(tab.repoId!),
      queryFn: ({ signal }: { signal: AbortSignal }) => readStatus(tab.repoId!, signal),
      enabled: !missing.has(tab.repoId!) && !locked.has(tab.repoId!),
    })),
  });
  const dirty = new Map<string, boolean>();
  // The latest status fetch can also report that the folder is gone – the repo list only learns about it later.
  const gone = new Set<string>();
  repoTabs.forEach((tab, index) => {
    const query = statuses[index];
    const code = query?.error instanceof CoreError ? query.error.code : null;
    if (locked.has(tab.repoId!)) return;
    if (missing.has(tab.repoId!) || code === "path_not_found" || code === "not_a_repo") {
      gone.add(tab.id);
      return;
    }
    const status = query?.data;
    dirty.set(tab.id, Boolean(status && status.unstaged.length + status.staged.length + status.conflicted.length > 0));
  });

  const repoOf = (tab: Tab) => (tab.kind === "repo" && tab.repoId ? repos?.find((repo) => repo.id === tab.repoId) : undefined);

  const items: RepoTab[] = tabs.map((tab) => {
    const repo = repoOf(tab);
    return {
      id: tab.id,
      title: tab.kind === "management" ? t("ui.tabs.management") : tab.title,
      path: tab.path ?? undefined,
      kind: tab.kind,
      dirty: dirty.get(tab.id) ?? false,
      missing: gone.has(tab.id),
      // Renaming directly on the tab: only for repository tabs whose entry has loaded.
      renamable: Boolean(repo),
      folderName: repo?.name,
    };
  });

  const active = tabs.find((tab) => tab.isActive) ?? tabs[0];

  // Numbered in the windows' order, so "Window 2" stays the same name in every window's menu.
  const self = core.windowLabel();
  const otherWindows = (windows ?? []).map((window, at) => ({ window, number: at + 1 })).filter(({ window }) => window.label !== self);

  const menuFor = (item: RepoTab, actions: TabMenuActions): MenuEntry[] => {
    const index = tabs.findIndex((tab) => tab.id === item.id);
    const tab = tabs[index];
    if (!tab) return [];
    const repo = repoOf(tab);
    const entries: MenuEntry[] = [
      {
        label: t("ui.closeTab"),
        shortcut: tab.isActive ? commandShortcut("tab.close") : undefined,
        onSelect: () => void closeTab(tab.id),
      },
      { label: t("shell.tabMenu.closeOthers"), disabled: tabs.length < 2, onSelect: () => void closeOtherTabs(tab.id) },
      { type: "separator" },
      // The alias is only a display name; the input opens directly on the tab.
      ...(repo
        ? ([
            {
              label: repo.alias ? t("ui.changeAlias") : t("ui.rename"),
              shortcut: "F2",
              icon: <PencilLine className="size-icon" aria-hidden />,
              hint: repo.alias ? t("shell.tabMenu.folder", { name: repo.name }) : t("shell.tabMenu.displayNameOnly"),
              onSelect: actions.rename,
            },
            ...(repo.alias
              ? [
                  {
                    label: t("ui.removeAlias"),
                    hint: t("shell.tabMenu.backTo", { name: repo.name }),
                    onSelect: () => void setTabAlias(repo, ""),
                  },
                ]
              : []),
            { type: "separator" },
          ] satisfies MenuEntry[])
        : []),
      { label: t("shell.tabMenu.moveLeft"), disabled: index === 0, onSelect: () => void moveTab(tab.id, index - 1) },
      { label: t("shell.tabMenu.moveRight"), disabled: index === tabs.length - 1, onSelect: () => void moveTab(tab.id, index + 1) },
      {
        label: t("windows.menu.moveToNew"),
        disabled: tabs.length < 2,
        hint: tabs.length < 2 ? t("windows.onlyTab") : undefined,
        onSelect: () => void moveTabToNewWindow(tab.id, null),
      },
      ...(otherWindows.length > 0
        ? [
            {
              label: t("windows.menu.moveToWindow"),
              children: otherWindows.map(({ window, number }) => ({
                label: window.title || t("windows.menu.windowN", { n: number }),
                onSelect: () => void moveTabToWindow(tab.id, window.label, window.tabs),
              })),
            },
          ]
        : []),
    ];
    if (tab.kind === "repo" && tab.repoId) {
      const repoId = tab.repoId;
      entries.push(
        { type: "separator" },
        { label: t("shell.tabMenu.cleanup"), disabled: gone.has(tab.id), onSelect: () => void openRepoCleanup(repoId) },
        { label: t("shell.tabMenu.showInFileManager"), onSelect: () => void openExternal(repoId, "file_manager") },
        {
          label: t("ui.copyPath"),
          disabled: !tab.path,
          onSelect: () => {
            if (!tab.path) return;
            const path = tab.path;
            void writeClipboard(path).then((ok) =>
              ok
                ? toast({ tone: "success", title: t("ui.pathCopied"), description: path })
                : toast({ tone: "warning", title: t("shell.tabMenu.clipboardUnavailable") }),
            );
          },
        },
      );
    }
    entries.push(
      { type: "separator" },
      { label: t("ui.tabs.new"), shortcut: commandShortcut("tab.new"), onSelect: () => void newTab() },
      { label: t("windows.menu.newWindow"), shortcut: commandShortcut("window.new"), onSelect: () => void newWindow() },
    );
    return entries;
  };

  return (
    <TabBar
      lead={<ProfileChip />}
      tabs={items}
      activeId={active?.id ?? ""}
      onActivate={(id) => {
        if (id !== active?.id) void activateTab(id);
      }}
      onClose={(id) => void closeTab(id)}
      onNew={() => void newTab()}
      onMove={(id, index) => void moveTab(id, index)}
      onRename={(id, value) => {
        const tab = tabs.find((candidate) => candidate.id === id);
        const repo = tab ? repoOf(tab) : undefined;
        if (repo) void setTabAlias(repo, value);
      }}
      menuFor={menuFor}
      renameRequest={renameRequest}
      onDragOut={(id, screen, insideSelf) => void dropTab(id, screen, insideSelf)}
      onStripReport={(strip) => void core.windowStripReport({ strip }).catch(() => undefined)}
    />
  );
}
