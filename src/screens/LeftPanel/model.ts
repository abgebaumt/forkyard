/**
 * Pure functions for the left panel: refs, remotes and stashes become a tree, and that becomes
 * the visible rows. No React, no core – so it can be tested in isolation.
 */
import type { Head, Ref, RefsSnapshot, Remote, Stash } from "../../core";
import { locale } from "../../i18n";

export type SectionKey = "local" | "remote" | "tags" | "stashes";

export const SECTION_ORDER: SectionKey[] = ["local", "remote", "tags", "stashes"];

/** This is how the graph hides all stashes (see graph_page in the core). */
export const STASH_REF = "refs/stash";

export type NodeKind = "branch" | "remote_branch" | "tag" | "stash" | "folder" | "remote" | "head";

export interface TreeNode {
  /** Unique across the whole panel: `fullName` for refs, otherwise with a prefix (`dir:`, `remote:`, `stash:`, `head:`). */
  id: string;
  section: SectionKey;
  kind: NodeKind;
  /** Displayed part of the name. */
  label: string;
  /** Full short name or path that is filtered against (e.g. "origin/feature/karte"). */
  path: string;
  /** Position of `label` within `path`. */
  labelStart: number;
  ref: Ref | null;
  stash: Stash | null;
  /** Only for `remote`: the entry from the remote list, if known. */
  remote: Remote | null;
  /** Only for `head`: detached HEAD or a branch without a commit. */
  head: Head | null;
  children: TreeNode[];
  /** `fullName` of all refs in this subtree; for a ref only its own. */
  refNames: string[];
}

export interface FlatRow {
  node: TreeNode;
  depth: number;
  parentId: string | null;
  /** undefined for leaves. */
  expanded: boolean | undefined;
  posInSet: number;
  setSize: number;
}

const collator = new Intl.Collator(locale(), { numeric: true, sensitivity: "base" });

const isContainer = (node: TreeNode) => node.kind === "folder" || node.kind === "remote";

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  nodes.sort((a, b) => {
    const containers = Number(isContainer(b)) - Number(isContainer(a));
    return containers !== 0 ? containers : collator.compare(a.label, b.label);
  });
  for (const node of nodes) if (node.children.length) sortNodes(node.children);
  return nodes;
}

function collectRefNames(node: TreeNode): string[] {
  if (node.ref) node.refNames = [node.ref.fullName];
  else node.refNames = node.children.flatMap(collectRefNames);
  return node.refNames;
}

function blank(section: SectionKey, kind: NodeKind, id: string, label: string, path: string, labelStart: number): TreeNode {
  return { id, section, kind, label, path, labelStart, ref: null, stash: null, remote: null, head: null, children: [], refNames: [] };
}

/**
 * Hangs `refs` under `roots`; "/" in the name becomes folders.
 * `base` is the part of the short name already represented by a parent node (for remotes "origin/").
 */
function insertRefs(section: SectionKey, kind: NodeKind, roots: TreeNode[], refs: Ref[], base: (ref: Ref) => string) {
  const folders = new Map<string, TreeNode>();
  for (const ref of refs) {
    const prefix = base(ref);
    const relative = ref.name.startsWith(prefix) ? ref.name.slice(prefix.length) : ref.name;
    const offset = ref.name.length - relative.length;
    const segments = relative.split("/");
    let siblings = roots;
    let position = offset;
    for (let index = 0; index < segments.length - 1; index++) {
      const segment = segments[index] ?? "";
      const path = ref.name.slice(0, position + segment.length);
      const key = `dir:${section}/${path}`;
      let folder = folders.get(key);
      if (!folder) {
        folder = blank(section, "folder", key, segment, path, position);
        folders.set(key, folder);
        siblings.push(folder);
      }
      siblings = folder.children;
      position += segment.length + 1;
    }
    const leaf = blank(section, kind, ref.fullName, segments[segments.length - 1] ?? relative, ref.name, position);
    leaf.ref = ref;
    siblings.push(leaf);
  }
}

export interface PanelTrees {
  local: TreeNode[];
  remote: TreeNode[];
  tags: TreeNode[];
  stashes: TreeNode[];
}

export function buildTrees(refs: RefsSnapshot | undefined, remotes: Remote[] | undefined, stashes: Stash[] | undefined): PanelTrees {
  const local: TreeNode[] = [];
  const remote: TreeNode[] = [];
  const tags: TreeNode[] = [];

  if (refs) {
    insertRefs("local", "branch", local, refs.locals, () => "");
    sortNodes(local);
    // Without a checked-out branch HEAD itself is on top: detached or still without a commit.
    if (refs.head.kind === "detached") {
      const node = blank("local", "head", "head:detached", "HEAD", "HEAD", 0);
      node.head = refs.head;
      local.unshift(node);
    } else if (refs.head.kind === "unborn") {
      const node = blank("local", "head", "head:unborn", refs.head.branch, refs.head.branch, 0);
      node.head = refs.head;
      local.unshift(node);
    }

    const byRemote = new Map<string, TreeNode>();
    const remoteNode = (name: string) => {
      let node = byRemote.get(name);
      if (!node) {
        node = blank("remote", "remote", `remote:${name}`, name, name, 0);
        byRemote.set(name, node);
        remote.push(node);
      }
      return node;
    };
    for (const entry of remotes ?? []) remoteNode(entry.name).remote = entry;
    const grouped = new Map<string, Ref[]>();
    for (const ref of refs.remotes) {
      const name = ref.remote ?? ref.name.split("/")[0] ?? "";
      const list = grouped.get(name);
      if (list) list.push(ref);
      else grouped.set(name, [ref]);
    }
    for (const [name, list] of grouped) insertRefs("remote", "remote_branch", remoteNode(name).children, list, () => `${name}/`);
    sortNodes(remote);

    insertRefs("tags", "tag", tags, refs.tags, () => "");
    sortNodes(tags);
  } else {
    for (const entry of remotes ?? []) {
      const node = blank("remote", "remote", `remote:${entry.name}`, entry.name, entry.name, 0);
      node.remote = entry;
      remote.push(node);
    }
  }

  for (const node of [...local, ...remote, ...tags]) collectRefNames(node);

  const stashNodes = (stashes ?? []).map((stash) => {
    const label = stash.message || `stash@{${stash.index}}`;
    const node = blank("stashes", "stash", `stash:${stash.sha}`, label, label, 0);
    node.stash = stash;
    return node;
  });

  return { local, remote, tags, stashes: stashNodes };
}

/**
 * Number of refs or stashes in a tree. Folders and remotes don't count, neither does a detached HEAD –
 * the branch without a commit does, though; it is the repository's one branch.
 */
export function countLeaves(nodes: TreeNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (isContainer(node)) count += countLeaves(node.children);
    else if (node.ref || node.stash || node.head?.kind === "unborn") count += 1;
  }
  return count;
}

const matches = (node: TreeNode, needle: string) =>
  node.path.toLowerCase().includes(needle) || (node.stash?.branch?.toLowerCase().includes(needle) ?? false);

/**
 * Keeps what contains the search text in its full name (case-insensitive). Folders and remotes stay
 * as long as a child matches; a remote without branches stays if its name matches.
 */
export function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;
  const result: TreeNode[] = [];
  for (const node of nodes) {
    if (isContainer(node)) {
      const children = filterTree(node.children, needle);
      if (children.length || (node.children.length === 0 && matches(node, needle))) result.push({ ...node, children });
    } else if (matches(node, needle)) {
      result.push(node);
    }
  }
  return result;
}

/** Ranges in `node.label` that belong to the search text – as [from, to) per match. */
export function highlightRanges(node: TreeNode, query: string): [number, number][] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const haystack = node.path.toLowerCase();
  const from = node.labelStart;
  const to = node.labelStart + node.label.length;
  const ranges: [number, number][] = [];
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    const start = Math.max(index, from);
    const end = Math.min(index + needle.length, to);
    if (start < end) ranges.push([start - from, end - from]);
    index = haystack.indexOf(needle, index + needle.length);
  }
  return ranges;
}

/** Visible rows in display order. `collapsed` holds the IDs of collapsed folders and remotes. */
export function flatten(nodes: TreeNode[], collapsed: ReadonlySet<string>, expandAll = false): FlatRow[] {
  const rows: FlatRow[] = [];
  const walk = (list: TreeNode[], depth: number, parentId: string | null) => {
    list.forEach((node, index) => {
      const container = isContainer(node);
      const expanded = container ? expandAll || !collapsed.has(node.id) : undefined;
      rows.push({ node, depth, parentId, expanded, posInSet: index + 1, setSize: list.length });
      if (container && expanded) walk(node.children, depth + 1, node.id);
    });
  };
  walk(nodes, 0, null);
  return rows;
}

export type Tri = "none" | "some" | "all";

/** How many of `names` are in `set`. */
export function triState(names: string[], set: ReadonlySet<string>): Tri {
  if (names.length === 0) return "none";
  let hits = 0;
  for (const name of names) if (set.has(name)) hits++;
  return hits === 0 ? "none" : hits === names.length ? "all" : "some";
}

/**
 * Toggles `names` in `list`: if all are already in, they come out, otherwise all go in.
 * Returns the new list.
 */
export function toggleNames(list: string[], names: string[]): string[] {
  const current = new Set(list);
  const allIn = names.length > 0 && names.every((name) => current.has(name));
  if (allIn) {
    const remove = new Set(names);
    return list.filter((name) => !remove.has(name));
  }
  return [...list, ...names.filter((name) => !current.has(name))];
}

/** Names a node stands for in hide and solo: its refs. */
export function namesOf(node: TreeNode): string[] {
  return node.refNames;
}

/** First node in the tree that `test` matches. */
export function findNode(nodes: TreeNode[], test: (node: TreeNode) => boolean): TreeNode | null {
  for (const node of nodes) {
    if (test(node)) return node;
    const inner = findNode(node.children, test);
    if (inner) return inner;
  }
  return null;
}
