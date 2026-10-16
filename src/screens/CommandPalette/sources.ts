/**
 * Sources of the command palette: commands, branches and tags, files, repositories, commits.
 * Every source returns uniform entries with a main action (Enter) and – where it makes sense –
 * a second level with more actions (Tab).
 */
import type { CommitSummary, FileChange, Id, Ref, RefsSnapshot, Repo, Sha, Status } from "../../core";
import type { AppCommand, CommandContext, CommandGroup } from "../../app/commandTypes";
import { checkout, createBranch, deleteBranches, renameBranch, chooseUpstream } from "../../app/actions/branches";
import { copyText } from "../../app/actions/clipboard";
import { openExternal } from "../../app/actions/files";
import { fastForwardBranch } from "../../app/actions/fastForward";
import { fastForward, mergeBranch, rebaseOnto } from "../../app/actions/merge";
import { openRepoTab } from "../../app/actions/repos";
import { deleteTag, pushTag } from "../../app/actions/tags";
import { formatRelative, shortSha } from "../../app/format";
import { useAppStore } from "../../app/store";
import { runCommand } from "../../app/registry";
import { rememberCommand } from "./recent";
import { unavailableReason } from "./reasons";
import { fold } from "./fuzzy";
import { t } from "../../i18n";

export type PaletteKind = "command" | "branch" | "remote" | "tag" | "file" | "repo" | "commit" | "action";

export const kindLabels: Record<PaletteKind, string> = {
  command: t("palette.kind.command"),
  branch: t("palette.kind.branch"),
  remote: t("palette.kind.remote"),
  tag: t("palette.kind.tag"),
  file: t("palette.kind.file"),
  repo: t("palette.kind.repo"),
  commit: t("palette.kind.commit"),
  action: t("palette.kind.action"),
};

/** Display names of the command groups (the groups themselves are fixed identifiers). */
export const groupTitles: Record<CommandGroup, string> = {
  Allgemein: t("palette.groups.general"),
  Tabs: t("palette.groups.tabs"),
  Ansicht: t("palette.groups.view"),
  Repository: t("palette.groups.repository"),
  Remote: t("palette.groups.remote"),
  Branch: t("palette.groups.branch"),
  Stash: t("palette.groups.stash"),
  Commit: t("palette.groups.commit"),
  Datei: t("palette.groups.file"),
};

/** Search words from a translation: comma-separated. */
const words = (key: string) => t(key).split(",").map((word) => word.trim()).filter(Boolean);

export interface PaletteItem {
  key: string;
  kind: PaletteKind;
  /** Visible main text; for files the whole path. */
  title: string;
  /** Folded for the search (prepared once). */
  folded: string;
  /** Addition in muted text (group, SHA, path of the repository). */
  detail?: string;
  keywords?: string[];
  /** Keyboard shortcut (commands). */
  shortcut?: string;
  /** Disabled: reason instead of shortcut; Enter shows the reason. */
  disabledReason?: string | null;
  /** Small hint next to the title (“checked out”, “modified”, “missing”). */
  marker?: string;
  /** Path search: matches in the file name count more. */
  path?: boolean;
  /** Bonus when sorting across sources. */
  boost?: number;
  run(): void | Promise<unknown>;
  /** Zweite Stufe (Tab). */
  actions?(): PaletteItem[];
}

const item = (value: Omit<PaletteItem, "folded">): PaletteItem => ({ ...value, folded: fold(value.title) });

// ---------------------------------------------------------------------------
// Befehle
// ---------------------------------------------------------------------------

/**
 * These commands make no sense in the palette: the palette itself, and “changes.discardAll”, which
 * does the same and has the same name as “wip.discardAll” (two identical rows below each other).
 */
const HIDDEN_COMMANDS = new Set(["app.palette", "palette.commands", "changes.discardAll"]);

const isHidden = (command: AppCommand, ctx: CommandContext) => {
  try {
    return command.hidden?.(ctx) ?? false;
  } catch {
    return true;
  }
};

export function commandItems(commands: readonly AppCommand[], ctx: CommandContext, available: (command: AppCommand) => boolean): PaletteItem[] {
  return commands
    .filter((command) => !HIDDEN_COMMANDS.has(command.id) && !isHidden(command, ctx))
    .map((command) => {
      const ok = available(command);
      return item({
        key: `command:${command.id}`,
        kind: "command",
        title: command.title,
        detail: groupTitles[command.group] ?? command.group,
        keywords: [...(command.keywords ?? []), command.group, groupTitles[command.group] ?? command.group],
        shortcut: command.shortcut,
        disabledReason: ok ? null : unavailableReason(command, ctx),
        boost: 3,
        run: () => {
          rememberCommand(command.id);
          return runCommand(command, "palette");
        },
      });
    });
}

// ---------------------------------------------------------------------------
// Branches and tags
// ---------------------------------------------------------------------------

interface RepoTarget {
  repoId: Id;
  tabId: Id;
}

const reveal = ({ tabId }: RepoTarget, sha: Sha) => {
  const store = useAppStore.getState();
  store.closeCenter(tabId);
  store.revealCommit(tabId, sha);
};

/**
 * “Fast-forward to <upstream>” for a local branch with upstream – as in the branch's context
 * menu: the checked-out one moves along with the files, any other only as a ref, without checkout.
 * If it is not possible right now, the reason is shown in the row.
 */
function fastForwardAction(target: RepoTarget, ref: Ref, key: string): PaletteItem | null {
  if (ref.kind !== "local" || !ref.upstream || ref.upstreamGone) return null;
  const upstream = ref.upstream;
  const blocked =
    ref.behind === 0
      ? t("palette.ff.upToDate")
      : ref.ahead > 0
        ? t("palette.ff.ownCommits", { count: ref.ahead })
        : !ref.isHead && ref.worktreePath
          ? t("palette.ff.otherWorktree")
          : null;
  return item({
    key,
    kind: "action",
    title: t("palette.ff.title", { upstream }),
    detail: blocked ? undefined : ref.isHead ? t("palette.commits", { count: ref.behind }) : t("palette.ff.withoutCheckout", { count: ref.behind }),
    keywords: ["ff", ...words("palette.ff.keywords")],
    disabledReason: blocked,
    run: () => (ref.isHead ? fastForward(target.repoId, upstream, target.tabId) : fastForwardBranch(target.repoId, ref.name, upstream)),
  });
}

function branchActions(target: RepoTarget, ref: Ref, current: string | null): PaletteItem[] {
  const { repoId, tabId } = target;
  const key = (suffix: string) => `action:${ref.fullName}:${suffix}`;
  const list: PaletteItem[] = [];
  if (!ref.isHead) {
    list.push(
      item({
        key: key("checkout"),
        kind: "action",
        title: ref.kind === "remote" ? t("palette.action.checkoutRemote") : t("palette.action.checkout"),
        run: () => checkout(repoId, ref.name, { tabId }),
      }),
    );
    if (current) {
      list.push(
        item({ key: key("merge"), kind: "action", title: t("palette.action.mergeInto", { branch: current }), run: () => mergeBranch(repoId, ref.name, undefined, tabId) }),
        item({ key: key("rebase"), kind: "action", title: t("palette.action.rebaseOnto", { branch: current }), run: () => rebaseOnto(repoId, ref.name, null, tabId) }),
      );
    }
  }
  const forward = fastForwardAction(target, ref, key("ff"));
  if (forward) list.push(forward);
  list.push(item({ key: key("reveal"), kind: "action", title: t("palette.action.reveal"), run: () => reveal(target, ref.sha) }));
  list.push(item({ key: key("branch"), kind: "action", title: t("palette.action.newBranchHere"), run: () => createBranch(repoId, { start: ref.name, tabId }) }));
  if (ref.kind === "local") {
    list.push(item({ key: key("rename"), kind: "action", title: t("palette.action.rename"), run: () => renameBranch(repoId, ref.name) }));
    list.push(item({ key: key("upstream"), kind: "action", title: t("palette.action.setUpstream"), run: () => chooseUpstream(repoId, ref.name) }));
  }
  list.push(item({ key: key("copy"), kind: "action", title: t("palette.action.copyName"), run: () => copyText(ref.name, t("palette.action.branchName")) }));
  if (ref.kind === "local" && !ref.isHead) {
    list.push(item({ key: key("delete"), kind: "action", title: t("palette.action.delete"), run: () => deleteBranches(repoId, [ref.name]) }));
  }
  return list;
}

function tagActions(target: RepoTarget, ref: Ref): PaletteItem[] {
  const { repoId, tabId } = target;
  const key = (suffix: string) => `action:${ref.fullName}:${suffix}`;
  return [
    item({ key: key("reveal"), kind: "action", title: t("palette.action.reveal"), run: () => reveal(target, ref.sha) }),
    item({ key: key("checkout"), kind: "action", title: t("palette.action.checkoutDetached"), run: () => checkout(repoId, ref.name, { tabId }) }),
    item({ key: key("branch"), kind: "action", title: t("palette.action.branchHere"), run: () => createBranch(repoId, { start: ref.name, tabId }) }),
    item({ key: key("push"), kind: "action", title: t("palette.action.pushTag"), run: () => pushTag(repoId, ref.name) }),
    item({ key: key("copy"), kind: "action", title: t("palette.action.copyName"), run: () => copyText(ref.name, t("palette.action.tagName")) }),
    item({ key: key("delete"), kind: "action", title: t("palette.action.delete"), run: () => deleteTag(repoId, ref.name, null) }),
  ];
}

export function refItems(target: RepoTarget, refs: RefsSnapshot): PaletteItem[] {
  const current = refs.head.kind === "branch" ? refs.head.branch : null;
  const branch = (ref: Ref): PaletteItem =>
    item({
      key: `ref:${ref.fullName}`,
      kind: ref.kind === "remote" ? "remote" : "branch",
      title: ref.name,
      detail: ref.upstream ? `${t("palette.ref.tracks", { upstream: ref.upstream })}${ref.ahead || ref.behind ? ` · ↑${ref.ahead} ↓${ref.behind}` : ""}` : shortSha(ref.sha),
      marker: ref.isHead ? t("palette.ref.checkedOut") : ref.worktreePath ? t("palette.ref.otherWorktree") : undefined,
      boost: ref.kind === "local" ? 2 : 1,
      // The checked-out branch: Enter shows it in the graph instead of a pointless checkout.
      run: () => (ref.isHead ? reveal(target, ref.sha) : checkout(target.repoId, ref.name, { tabId: target.tabId })),
      actions: () => branchActions(target, ref, current),
    });
  const tag = (ref: Ref): PaletteItem =>
    item({
      key: `ref:${ref.fullName}`,
      kind: "tag",
      title: ref.name,
      detail: ref.annotation ? `${shortSha(ref.sha)} · ${ref.annotation.split("\n")[0]}` : shortSha(ref.sha),
      boost: 1,
      run: () => reveal(target, ref.sha),
      actions: () => tagActions(target, ref),
    });
  return [...refs.locals.map(branch), ...refs.remotes.map(branch), ...refs.tags.map(tag)];
}

// ---------------------------------------------------------------------------
// Dateien
// ---------------------------------------------------------------------------

function fileActions(target: RepoTarget, path: string, change: { area: "unstaged" | "staged" | "conflicted" } | null): PaletteItem[] {
  const { repoId, tabId } = target;
  const store = () => useAppStore.getState();
  const key = (suffix: string) => `action:file:${path}:${suffix}`;
  const list: PaletteItem[] = [];
  if (change) list.push(item({ key: key("diff"), kind: "action", title: t("palette.action.showDiff"), run: () => openChange(target, path, change.area) }));
  list.push(
    item({ key: key("view"), kind: "action", title: t("palette.action.viewFile"), run: () => store().openFile(tabId, path, null, "view") }),
    item({ key: key("edit"), kind: "action", title: t("palette.action.editFile"), run: () => store().openFile(tabId, path, null, "edit") }),
    item({ key: key("history"), kind: "action", title: t("palette.action.fileHistory"), run: () => store().openHistory(tabId, path) }),
    item({ key: key("blame"), kind: "action", title: t("palette.action.blame"), run: () => store().openBlame(tabId, path, null) }),
    item({ key: key("external"), kind: "action", title: t("palette.action.openExternal"), run: () => openExternal(repoId, "editor", path) }),
    item({ key: key("copy"), kind: "action", title: t("palette.action.copyPath"), run: () => copyText(path, t("palette.action.path")) }),
  );
  return list;
}

function openChange(target: RepoTarget, path: string, area: "unstaged" | "staged" | "conflicted") {
  const store = useAppStore.getState();
  store.selectWip(target.tabId);
  store.setRightCollapsed(target.tabId, false);
  if (area === "conflicted") store.openConflict(target.tabId, path);
  else store.openDiff(target.tabId, path, { kind: area });
}

const changeMarker: Record<FileChange["status"], string> = {
  modified: t("ui.fileStatus.modified"),
  added: t("ui.fileStatus.added"),
  deleted: t("ui.fileStatus.deleted"),
  renamed: t("ui.fileStatus.renamed"),
  conflicted: t("ui.fileStatus.conflicted"),
  untracked: t("ui.fileStatus.added"),
};

export function fileItems(target: RepoTarget, paths: readonly string[], status: Status | undefined): PaletteItem[] {
  const changes = new Map<string, { area: "unstaged" | "staged" | "conflicted"; status: FileChange["status"] }>();
  for (const file of status?.staged ?? []) changes.set(file.path, { area: "staged", status: file.status });
  for (const file of status?.unstaged ?? []) changes.set(file.path, { area: "unstaged", status: file.status });
  for (const file of status?.conflicted ?? []) changes.set(file.path, { area: "conflicted", status: "conflicted" });
  const make = (path: string): PaletteItem => {
    const change = changes.get(path) ?? null;
    return item({
      key: `file:${path}`,
      kind: "file",
      title: path,
      marker: change ? changeMarker[change.status] : undefined,
      path: true,
      boost: change ? 1 : 0,
      run: () => (change ? openChange(target, path, change.area) : useAppStore.getState().openFile(target.tabId, path, null, "view")),
      actions: () => fileActions(target, path, change),
    });
  };
  // Changed files that are not (or no longer) in the directory tree (deleted) are added.
  const seen = new Set(paths);
  const extra = [...changes.keys()].filter((path) => !seen.has(path));
  return [...paths, ...extra].map(make);
}

/** Changed files first – for the empty file search. */
export function changedFirst(items: PaletteItem[]): PaletteItem[] {
  return [...items.filter((entry) => entry.marker), ...items.filter((entry) => !entry.marker)];
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export function repoItems(repos: readonly Repo[], activeRepoId: Id | null): PaletteItem[] {
  return [...repos]
    .sort((a, b) => (b.lastOpenedAt ?? "").localeCompare(a.lastOpenedAt ?? ""))
    .map((repo) =>
      item({
        key: `repo:${repo.id}`,
        kind: "repo",
        title: repo.alias ?? repo.name,
        detail: repo.path,
        keywords: [repo.name, repo.path, ...(repo.groupName ? [repo.groupName] : [])],
        marker: repo.missing ? t("palette.repo.missing") : repo.id === activeRepoId ? t("palette.repo.open") : undefined,
        boost: 1,
        run: () => openRepoTab(repo.id),
      }),
    );
}

// ---------------------------------------------------------------------------
// Commits (search via the core)
// ---------------------------------------------------------------------------

export function commitItems(target: RepoTarget, commits: readonly CommitSummary[]): PaletteItem[] {
  return commits.map((commit) =>
    item({
      key: `commit:${commit.sha}`,
      kind: "commit",
      title: commit.summary || t("palette.commit.noMessage"),
      detail: `${shortSha(commit.sha)} · ${commit.author.name} · ${formatRelative(commit.authoredAt)}`,
      run: () => reveal(target, commit.sha),
      actions: () => [
        item({ key: `action:commit:${commit.sha}:reveal`, kind: "action", title: t("palette.action.reveal"), run: () => reveal(target, commit.sha) }),
        item({ key: `action:commit:${commit.sha}:branch`, kind: "action", title: t("palette.action.branchHere"), run: () => createBranch(target.repoId, { start: commit.sha, tabId: target.tabId }) }),
        item({ key: `action:commit:${commit.sha}:copy`, kind: "action", title: t("palette.action.copySha"), run: () => copyText(commit.sha, "SHA") }),
      ],
    }),
  );
}
