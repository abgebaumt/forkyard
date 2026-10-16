import { useEffect, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { PencilLine } from "lucide-react";
import { CoreError, type Tab } from "../../core";
import { TabBar, type RepoTab, type TabMenuActions } from "../../ui/Chrome";
import { toast } from "../../ui/Feedback";
import type { MenuEntry } from "../../ui/Menu";
import { openExternal } from "../actions/files";
import { openRepoCleanup } from "../../screens/RepoCleanup";
import { activateTab, closeOtherTabs, closeTab, moveTab, newTab } from "../actions/repos";
import { qk, useRepos } from "../queries";
import { readStatus } from "../statusOrder";
import { ProfileChip } from "./ProfileChip";
import { onTabRenameRequest, setTabAlias } from "./tabAlias";
import { t } from "../../i18n";

/** Tab strip from the core's tab list: activate, close, drag, context menu, dot for changes. */
export function TabStrip({ tabs }: { tabs: Tab[] }) {
  const { data: repos } = useRepos();
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

  const menuFor = (item: RepoTab, actions: TabMenuActions): MenuEntry[] => {
    const index = tabs.findIndex((tab) => tab.id === item.id);
    const tab = tabs[index];
    if (!tab) return [];
    const repo = repoOf(tab);
    const entries: MenuEntry[] = [
      { label: t("shell.tabMenu.close"), shortcut: tab.isActive ? "Mod+W" : undefined, onSelect: () => void closeTab(tab.id) },
      { label: t("shell.tabMenu.closeOthers"), disabled: tabs.length < 2, onSelect: () => void closeOtherTabs(tab.id) },
      { type: "separator" },
      // The alias is only a display name; the input opens directly on the tab.
      ...(repo
        ? ([
            { label: repo.alias ? t("shell.tabMenu.changeAlias") : t("shell.tabMenu.rename"), shortcut: "F2", icon: <PencilLine className="size-icon" aria-hidden />, hint: repo.alias ? t("shell.tabMenu.folder", { name: repo.name }) : t("shell.tabMenu.displayNameOnly"), onSelect: actions.rename },
            ...(repo.alias ? [{ label: t("shell.alias.remove"), hint: t("shell.tabMenu.backTo", { name: repo.name }), onSelect: () => void setTabAlias(repo, "") }] : []),
            { type: "separator" },
          ] satisfies MenuEntry[])
        : []),
      { label: t("shell.tabMenu.moveLeft"), disabled: index === 0, onSelect: () => void moveTab(tab.id, index - 1) },
      { label: t("shell.tabMenu.moveRight"), disabled: index === tabs.length - 1, onSelect: () => void moveTab(tab.id, index + 1) },
    ];
    if (tab.kind === "repo" && tab.repoId) {
      const repoId = tab.repoId;
      entries.push(
        { type: "separator" },
        { label: t("shell.tabMenu.cleanup"), disabled: gone.has(tab.id), onSelect: () => void openRepoCleanup(repoId) },
        { label: t("shell.tabMenu.showInFileManager"), onSelect: () => void openExternal(repoId, "file_manager") },
        {
          label: t("shell.tabMenu.copyPath"),
          disabled: !tab.path,
          onSelect: () => {
            if (!tab.path) return;
            void navigator.clipboard
              ?.writeText(tab.path)
              .then(() => toast({ tone: "success", title: t("shell.tabMenu.pathCopied"), description: tab.path ?? undefined }))
              .catch(() => toast({ tone: "warning", title: t("shell.tabMenu.clipboardUnavailable") }));
          },
        },
      );
    }
    entries.push({ type: "separator" }, { label: t("ui.tabs.new"), shortcut: "Mod+T", onSelect: () => void newTab() });
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
    />
  );
}
