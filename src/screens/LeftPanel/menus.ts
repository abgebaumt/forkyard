/**
 * Context menus of the left panel. The Git actions come from src/app/menus (the same as on the graph);
 * here only what belongs to the panel is added: view (hide, solo, folders, sections) and inline renaming.
 */
import type { Id, Remote } from "../../core";
import { branchMenu, branchesMenu, dropMenu, remoteMenu, stashMenu, tagMenu } from "../../app/menus";
import type { MenuAction, MenuEntry } from "../../ui/Menu";
import { t } from "../../i18n";
import { SECTION_ORDER, type SectionKey, type TreeNode, type Tri } from "./model";

export const sectionTitles: Record<SectionKey, string> = {
  local: t("sidebar.section.local"),
  remote: t("sidebar.section.remote"),
  tags: t("sidebar.section.tags"),
  stashes: t("sidebar.section.stashes"),
};

const isAction = (entry: MenuEntry): entry is MenuAction => entry.type === undefined || entry.type === "item";

/** Appends `extra` as its own group – without a doubled or leading separator. */
function withGroup(base: MenuEntry[], extra: MenuEntry[]): MenuEntry[] {
  if (!extra.length) return base;
  if (!base.length) return extra;
  return [...base, { type: "separator" }, ...extra];
}

const nothing: MenuEntry[] = [{ label: t("sidebar.menu.none"), disabled: true }];

export interface RowMenuContext {
  repoId: Id;
  tabId: Id;
  node: TreeNode;
  expanded: boolean | undefined;
  hidden: Tri;
  solo: Tri;
  /** View state loaded – otherwise there is no hide and solo. */
  canToggle: boolean;
  /** Marked local branches, if the row is one of them and there are several. */
  selectedBranches: TreeNode[];
  remote: Remote | null;
  toggleExpanded(): void;
  toggleHide(): void;
  toggleSolo(): void;
  startRename(): void;
  reveal(): void;
  /** Main action of the row (checkout). */
  activate(): void;
  /** Deletes the row or the marked branches (with a prompt). */
  remove(): void;
}

function viewEntries(ctx: RowMenuContext, existing: MenuEntry[]): MenuEntry[] {
  const { node, hidden, solo } = ctx;
  if (!ctx.canToggle || node.refNames.length === 0 || node.kind === "stash" || node.kind === "head") return [];
  // If the shared menu already offers hide or solo, it is not added twice here (German and English labels).
  if (existing.some((entry) => isAction(entry) && /ausblenden|\bhide\b|\bsolo\b/i.test(entry.label))) return [];
  const many = node.kind === "folder" || node.kind === "remote";
  return [
    {
      label: hidden === "all" ? (many ? t("sidebar.toggle.showMany") : t("sidebar.toggle.show")) : many ? t("sidebar.toggle.hideMany") : t("sidebar.toggle.hideOne"),
      checked: hidden === "all",
      onSelect: ctx.toggleHide,
    },
    {
      label: solo === "all" ? t("sidebar.toggle.soloEnd") : many ? t("sidebar.toggle.soloMany") : t("sidebar.toggle.soloOne"),
      checked: solo === "all",
      onSelect: ctx.toggleSolo,
    },
  ];
}

export function rowMenu(ctx: RowMenuContext): MenuEntry[] {
  const { node, repoId, tabId } = ctx;
  const base = { repoId, tabId };

  if (node.kind === "branch" && node.ref) {
    if (ctx.selectedBranches.length > 1) {
      const refs = ctx.selectedBranches.flatMap((item) => (item.ref ? [item.ref] : []));
      const entries = branchesMenu({ ...base, refs });
      // As long as the shared menu yields nothing, at least delete stays reachable.
      return entries.length ? entries : [{ label: t("sidebar.menu.deleteBranches", { count: refs.length }), shortcut: "Delete", danger: true, onSelect: ctx.remove }];
    }
    let renameOffered = false;
    // "Rename" from the shared menu opens the inline input in the row here.
    const shared = branchMenu({ ...base, ref: node.ref }).map((entry): MenuEntry => {
      if (!isAction(entry) || !/^(umbenennen|rename)/i.test(entry.label.trim())) return entry;
      renameOffered = true;
      return { ...entry, label: t("sidebar.menu.rename"), shortcut: "F2", onSelect: ctx.startRename };
    });
    const rename: MenuEntry = { label: t("sidebar.menu.rename"), shortcut: "F2", onSelect: ctx.startRename };
    // As long as the shared menu yields nothing, checkout and delete stay reachable here.
    const entries: MenuEntry[] = shared.length
      ? withGroup(shared, renameOffered ? [] : [rename])
      : [
          { label: t("sidebar.menu.checkout"), shortcut: "Enter", disabled: node.ref.isHead, onSelect: ctx.activate },
          rename,
          { label: t("sidebar.menu.deleteBranch"), shortcut: "Delete", danger: true, disabled: node.ref.isHead, onSelect: ctx.remove },
        ];
    return withGroup(entries, viewEntries(ctx, entries));
  }

  if (node.kind === "remote_branch" && node.ref) {
    const shared = branchMenu({ ...base, ref: node.ref });
    const entries: MenuEntry[] = shared.length ? shared : [{ label: t("sidebar.menu.checkout"), shortcut: "Enter", onSelect: ctx.activate }];
    return withGroup(entries, viewEntries(ctx, entries));
  }

  if (node.kind === "tag" && node.ref) {
    const entries = tagMenu({ ...base, ref: node.ref });
    return withGroup(entries, viewEntries(ctx, entries));
  }

  if (node.kind === "stash" && node.stash) {
    const entries = stashMenu({ ...base, stash: node.stash });
    return entries.length ? entries : [{ label: t("sidebar.menu.viewStash"), onSelect: ctx.reveal }];
  }

  const fold: MenuEntry[] = ctx.expanded === undefined ? [] : [{ label: ctx.expanded ? t("sidebar.menu.collapse") : t("sidebar.menu.expand"), onSelect: ctx.toggleExpanded }];

  if (node.kind === "remote") {
    const shared = ctx.remote ? remoteMenu({ ...base, remote: ctx.remote }) : [];
    const entries = withGroup(shared, fold);
    return withGroup(entries, viewEntries(ctx, entries));
  }

  if (node.kind === "folder") return withGroup(fold, viewEntries(ctx, fold));

  return [{ label: t("sidebar.menu.showInGraph"), onSelect: ctx.reveal, disabled: node.head?.kind === "unborn" }];
}

export interface DropMenuContext {
  repoId: Id;
  tabId: Id;
  source: TreeNode;
  target: TreeNode;
}

/** After dropping a branch onto another. Without a choice nothing happens. */
export function dropEntries({ repoId, tabId, source, target }: DropMenuContext): MenuEntry[] {
  if (!source.ref || !target.ref) return nothing;
  const entries = dropMenu({ repoId, tabId, source: source.ref, target: target.ref });
  const heading: MenuEntry = { type: "label", label: `${source.ref.name} → ${target.ref.name}` };
  return [heading, ...(entries.length ? entries : nothing)];
}

export interface SectionMenuContext {
  section: SectionKey;
  collapsed: boolean;
  maximized: boolean;
  hidden: Tri;
  solo: Tri;
  canToggle: boolean;
  /** Whether the section has refs that can be hidden. */
  hasRefs: boolean;
  /** Visibility of all sections. */
  visible: Record<SectionKey, boolean>;
  toggleCollapsed(): void;
  toggleMaximized(): void;
  toggleHide(): void;
  toggleSolo(): void;
  setVisible(section: SectionKey, visible: boolean): void;
}

export function sectionMenu(ctx: SectionMenuContext): MenuEntry[] {
  const shown = SECTION_ORDER.filter((key) => ctx.visible[key]);
  const title = sectionTitles[ctx.section];
  const view: MenuEntry[] =
    ctx.canToggle && ctx.hasRefs
      ? [
          { type: "separator" },
          {
            label: ctx.hidden === "all" ? t("sidebar.section.show", { title }) : t("sidebar.section.hide", { title }),
            checked: ctx.hidden === "all",
            onSelect: ctx.toggleHide,
          },
          ...(ctx.section === "stashes"
            ? []
            : [{ label: ctx.solo === "all" ? t("sidebar.toggle.soloEnd") : t("sidebar.section.solo", { title }), checked: ctx.solo === "all", onSelect: ctx.toggleSolo }]),
        ]
      : [];
  return [
    { label: ctx.collapsed ? t("sidebar.menu.expand") : t("sidebar.menu.collapse"), onSelect: ctx.toggleCollapsed },
    { label: ctx.maximized ? t("sidebar.section.showAll") : t("sidebar.section.maximize"), onSelect: ctx.toggleMaximized },
    { label: t("sidebar.section.hideSection"), disabled: shown.length <= 1, onSelect: () => ctx.setVisible(ctx.section, false) },
    ...view,
    { type: "separator" },
    { type: "label", label: t("sidebar.section.sections") },
    ...SECTION_ORDER.map(
      (key): MenuEntry => ({
        label: sectionTitles[key],
        checked: ctx.visible[key],
        // The last visible section stays, otherwise the panel would be empty.
        disabled: ctx.visible[key] && shown.length <= 1,
        onSelect: () => ctx.setVisible(key, !ctx.visible[key]),
      }),
    ),
  ];
}
