import { memo, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Archive, Cloud, CloudOff, Eye, EyeOff, Focus, Folder, FolderGit2, FolderOpen, GitBranch, GitCommitHorizontal, Loader2, Tag } from "lucide-react";
import { normalizeRefName } from "../../app/actions/branches";
import { outgoing, refPublishState } from "../../app/publishState";

import type { Ref } from "../../core";
import { formatDateTime, formatRelative, shortSha } from "../../app/format";
import { IconButton } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { TreeRow } from "../../ui/Git";
import { Tip } from "../../ui/Tooltip";
import { t } from "../../i18n";
import { highlightRanges, type FlatRow, type TreeNode, type Tri } from "./model";

/** What a row in the panel can trigger. The functions stay the same across renders. */
export interface RowApi {
  toggleHide(node: TreeNode): void;
  toggleSolo(node: TreeNode): void;
  /** Reason why the name is not allowed, or null. */
  validateName(name: string): Promise<string | null>;
  /** Renames. Returns null on success, otherwise the reason to show in the row. */
  rename(node: TreeNode, name: string): Promise<string | null>;
  /** Close the input without renaming. `refocus`: focus goes back to the row. */
  endRename(refocus: boolean): void;
}

export interface RefRowProps {
  row: FlatRow;
  query: string;
  selected: boolean;
  focusable: boolean;
  /** Explicitly hidden (for folders: all, some, none). */
  hidden: Tri;
  solo: Tri;
  /** The graph is not showing the entry right now – hidden, or another one is solo. */
  dimmed: boolean;
  /** Hide and solo are usable (view state loaded, the row has refs). */
  canToggle: boolean;
  dragging: boolean;
  dropTarget: boolean;
  busy: boolean;
  editing: boolean;
  /** The section has folders: leaves leave room for the arrow so the icons line up. */
  gutter: boolean;
  api: RowApi;
}

function Highlighted({ text, ranges }: { text: string; ranges: [number, number][] }) {
  if (!ranges.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], index) => {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark key={index} className="rounded-sm bg-warning-surface text-text">
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/** "2 commits ahead, 1 commit behind origin/main" */
export function syncText(ahead: number, behind: number, upstream: string | null): string {
  const parts = [
    ahead ? t("sidebar.sync.ahead", { count: ahead }) : null,
    behind ? t("sidebar.sync.behind", { count: behind }) : null,
  ].filter(Boolean);
  const text = parts.join(", ");
  return upstream ? t("sidebar.sync.against", { text, upstream }) : text;
}

/**
 * Counters and their tooltip for a row. A local branch that is not on its remote (no upstream, gone,
 * or an upstream of another name a plain push doesn't reach) shows its unpublished commits as
 * outgoing – with the arrow even at 0, the branch itself is still to push. "Behind" an upstream of
 * another name still counts.
 */
export function rowSync(ref: Ref): { ahead: number; behind: number; outgoing: boolean; tip: string } {
  const state = ref.kind === "local" ? refPublishState(ref) : null;
  const pending = state ? outgoing(state) : null;
  if (state && pending?.isNew) {
    const behind = state.kind === "elsewhere" ? state.behind : 0;
    const parts = [
      pending.count ? t("sidebar.sync.unpublished", { count: pending.count }) : t("sidebar.sync.unpublishedNone"),
      state.kind === "elsewhere" ? t("sidebar.sync.followsOther", { upstream: state.upstream }) : null,
      behind ? t("sidebar.sync.behind", { count: behind }) : null,
    ].filter(Boolean);
    return { ahead: pending.count, behind, outgoing: true, tip: parts.join(", ") };
  }
  if (state?.kind === "elsewhere") {
    const behind = state.behind ? `, ${t("sidebar.sync.behind", { count: state.behind })}` : "";
    return { ahead: 0, behind: state.behind, outgoing: false, tip: `${t("sidebar.sync.followsOther", { upstream: state.upstream })}${behind}` };
  }
  return { ahead: ref.ahead, behind: ref.behind, outgoing: false, tip: syncText(ref.ahead, ref.behind, ref.upstream) };
}

const kindText: Record<TreeNode["kind"], string> = {
  branch: t("sidebar.kind.branch"),
  remote_branch: t("sidebar.kind.remoteBranch"),
  tag: t("sidebar.kind.tag"),
  stash: t("sidebar.kind.stash"),
  folder: t("sidebar.kind.folder"),
  remote: t("sidebar.kind.remote"),
  head: "HEAD",
};

/** Lines of the tooltip on the name. */
function tipLines(node: TreeNode): string[] {
  const { ref, stash, remote, head } = node;
  if (node.kind === "branch" && ref) {
    return [
      ref.name,
      ref.upstreamGone
        ? t("sidebar.tip.upstreamGone", { upstream: ref.upstream ?? "" })
        : ref.upstream
          ? ref.pushesToUpstream
            ? t("sidebar.tip.upstream", { upstream: ref.upstream })
            : t("sidebar.tip.followsOther", { upstream: ref.upstream })
          : t("sidebar.tip.noUpstream"),
      ...(ref.worktreePath ? [t("sidebar.tip.inWorktree", { path: ref.worktreePath })] : []),
    ];
  }
  if (node.kind === "remote_branch" && ref) return [ref.name];
  if (node.kind === "tag" && ref) return [ref.name, ref.isAnnotated ? (ref.annotation?.trim() || t("sidebar.tip.annotatedEmpty")) : t("sidebar.tip.lightweight")];
  if (stash) {
    return [
      node.label,
      `stash@{${stash.index}}${stash.branch ? t("sidebar.tip.stashOn", { branch: stash.branch }) : ""} · ${t("sidebar.tip.files", { count: stash.fileCount })}`,
      formatDateTime(stash.createdAt),
    ];
  }
  if (node.kind === "remote") {
    return [
      node.label,
      ...(remote ? [remote.fetchUrl, ...(remote.pushUrl ? [`Push: ${remote.pushUrl}`] : [])] : []),
      ...(node.children.length === 0 ? [t("sidebar.tip.noBranchesFetched")] : []),
    ];
  }
  if (node.kind === "folder") return [`${node.path}/`, t("sidebar.tip.entries", { count: node.refNames.length })];
  if (head?.kind === "detached") return [t("sidebar.tip.detached", { sha: shortSha(head.sha) })];
  if (head?.kind === "unborn") return [t("sidebar.tip.unborn", { branch: head.branch })];
  return [node.label];
}

/** What a screen reader announces for the row: kind, full name and state as text. */
function describe(node: TreeNode, hidden: Tri, solo: Tri): string {
  const { ref, stash, head } = node;
  const parts = [`${kindText[node.kind]} ${node.kind === "head" && head?.kind === "detached" ? shortSha(head.sha) : node.path}`];
  if (ref?.isHead) parts.push(t("sidebar.describe.checkedOut"));
  if (head?.kind === "detached") parts.push(t("sidebar.describe.detached"));
  if (head?.kind === "unborn") parts.push(t("sidebar.describe.unborn"));
  const sync = ref && ref.kind === "local" ? rowSync(ref) : null;
  if (sync && (sync.outgoing || refPublishState(ref!).kind === "elsewhere")) parts.push(sync.tip);
  else if (ref && (ref.ahead || ref.behind)) parts.push(syncText(ref.ahead, ref.behind, ref.upstream));
  if (ref?.upstreamGone) parts.push(t("sidebar.describe.upstreamMissing"));
  if (node.kind === "branch" && ref?.worktreePath) parts.push(t("sidebar.describe.inWorktree"));
  if (ref?.isAnnotated && ref.annotation) parts.push(ref.annotation.trim());
  if (stash) parts.push(`${stash.branch ? t("sidebar.describe.stashOn", { branch: stash.branch }) : ""}${formatRelative(stash.createdAt)}`);
  if (hidden === "all") parts.push(t("sidebar.describe.hidden"));
  else if (hidden === "some") parts.push(t("sidebar.describe.partlyHidden"));
  if (solo === "all") parts.push(t("sidebar.describe.solo"));
  else if (solo === "some") parts.push(t("sidebar.describe.partlySolo"));
  return parts.join(", ");
}

function InlineRename({ node, api, onError }: { node: TreeNode; api: RowApi; onError: (reason: string | null, id: string) => void }) {
  const original = node.ref?.name ?? node.label;
  const [value, setValue] = useState(original);
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const run = useRef(0);
  const done = useRef(false);
  const openedAt = useRef(performance.now());

  const report = (reason: string | null) => {
    setInvalid(Boolean(reason));
    onError(reason, errorId);
  };

  useEffect(() => {
    const input = inputRef.current;
    input?.focus();
    input?.select();
  }, []);

  // While typing, check against Git's rules and existing names.
  useEffect(() => {
    const name = value.trim();
    const mine = ++run.current;
    if (!name || name === original) {
      report(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void api.validateName(name).then((reason) => {
        if (run.current === mine) report(reason);
      });
    }, 150);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const submit = async () => {
    const name = value.trim();
    if (!name || name === original) {
      done.current = true;
      api.endRename(true);
      return;
    }
    run.current++;
    setBusy(true);
    const reason = (await api.validateName(name)) ?? (await api.rename(node, name));
    if (reason) {
      report(reason);
      setBusy(false);
      inputRef.current?.focus();
      return;
    }
    done.current = true;
  };

  return (
    <input
      ref={inputRef}
      value={value}
      readOnly={busy}
      aria-busy={busy || undefined}
      aria-label={t("sidebar.rename.label", { name: original })}
      aria-invalid={invalid || undefined}
      aria-describedby={invalid ? errorId : undefined}
      spellCheck={false}
      autoComplete="off"
      data-rename-input
      className="block h-5 w-full rounded-sm border border-border-input bg-surface-sunken px-1 font-mono text-code font-normal text-text aria-invalid:border-danger"
      onChange={(event) => setValue(normalizeRefName(event.target.value))}
      onKeyDown={(event) => {
        // The keys belong to the field, not to the tree.
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          if (!busy) void submit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          done.current = true;
          api.endRename(true);
        }
      }}
      onKeyUp={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      onBlur={() => {
        if (busy || done.current) return;
        // A menu that is just closing briefly takes focus back: then the input stays open.
        if (performance.now() - openedAt.current < 250) {
          window.setTimeout(() => inputRef.current?.focus(), 0);
          return;
        }
        api.endRename(false);
      }}
    />
  );
}

function RefRowInner({ row, query, selected, focusable, hidden, solo, dimmed, canToggle, dragging, dropTarget, busy, editing, gutter, api }: RefRowProps) {
  const { node, depth, expanded, posInSet, setSize } = row;
  const { ref, stash, head } = node;
  const sync = ref ? rowSync(ref) : undefined;
  const [renameError, setRenameError] = useState<{ reason: string; id: string } | null>(null);

  useEffect(() => {
    if (!editing) setRenameError(null);
  }, [editing]);

  let icon: ReactNode;
  if (busy) icon = <Loader2 className="size-3.5 animate-spin" aria-hidden />;
  else if (node.kind === "folder") icon = expanded ? <FolderOpen className="size-3.5" aria-hidden /> : <Folder className="size-3.5" aria-hidden />;
  else if (node.kind === "remote") icon = <Cloud className="size-3.5" aria-hidden />;
  else if (node.kind === "tag") icon = <Tag className="size-3.5" aria-hidden />;
  else if (node.kind === "stash") icon = <Archive className="size-3.5" aria-hidden />;
  else if (node.kind === "head") icon = <GitCommitHorizontal className="size-3.5" aria-hidden />;
  else icon = <GitBranch className="size-3.5" aria-hidden />;

  const lines = tipLines(node);
  const tip = (
    <span className="flex flex-col gap-0.5">
      {lines.map((line, index) => (
        <span key={index} className={cn("break-all whitespace-pre-line", index > 0 && "text-text-muted")}>
          {line}
        </span>
      ))}
    </span>
  );

  let meta: ReactNode = null;
  if (editing && renameError) {
    meta = (
      <span
        id={renameError.id}
        role="alert"
        className="absolute inset-x-2 top-full z-20 mt-0.5 rounded-md border border-danger bg-surface-raised px-2 py-1 text-sm font-normal text-danger shadow-pop"
      >
        {renameError.reason}
      </span>
    );
  } else if (ref?.upstreamGone) {
    meta = (
      <Tip label={t("sidebar.tip.upstreamGone", { upstream: ref.upstream ?? "" })} side="right">
        <span className="inline-flex shrink-0 items-center text-warning" data-upstream-gone>
          <CloudOff className="size-3.5" aria-hidden />
          <span className="sr-only">{t("sidebar.describe.upstreamMissing")}</span>
        </span>
      </Tip>
    );
  } else if (node.kind === "branch" && ref?.worktreePath) {
    meta = (
      <Tip label={t("sidebar.tip.inWorktree", { path: ref.worktreePath })} side="right">
        <span className="inline-flex shrink-0 items-center text-text-muted" data-in-worktree>
          <FolderGit2 className="size-3.5" aria-hidden />
          <span className="sr-only">{t("sidebar.describe.inWorktree")}</span>
        </span>
      </Tip>
    );
  } else if (head?.kind === "detached") {
    meta = <span className="shrink-0 font-mono text-xs text-text-muted">{shortSha(head.sha)}</span>;
  } else if (head?.kind === "unborn") {
    meta = <span className="shrink-0 text-xs text-text-muted">{t("sidebar.noCommitYet")}</span>;
  }

  const stop = { onPointerDown: (event: { stopPropagation(): void }) => event.stopPropagation(), onDoubleClick: (event: { stopPropagation(): void }) => event.stopPropagation() };
  const showToggles = canToggle && !editing && node.kind !== "stash" && node.kind !== "head" && node.refNames.length > 0;
  const lazy = "hidden group-hover:inline-flex group-focus-within:inline-flex";
  const many = node.kind === "folder" || node.kind === "remote";
  // A toggle that is switched on stays visible; the others appear on hover and focus.
  const trailing = showToggles ? (
    <>
      <span className={solo === "none" ? lazy : "inline-flex"}>
        <IconButton
          size="sm"
          tabIndex={-1}
          data-toggle="solo"
          label={solo === "all" ? t("sidebar.toggle.soloEnd") : many ? t("sidebar.toggle.soloMany") : t("sidebar.toggle.soloOne")}
          active={solo === "all"}
          icon={<Focus className="size-3.5" aria-hidden />}
          onClick={(event) => {
            event.stopPropagation();
            api.toggleSolo(node);
          }}
          {...stop}
        />
      </span>
      <span className={hidden === "none" ? lazy : "inline-flex"}>
        <IconButton
          size="sm"
          tabIndex={-1}
          data-toggle="hide"
          label={hidden === "all" ? t("sidebar.toggle.show") : many ? t("sidebar.toggle.hideMany") : t("sidebar.toggle.hideOne")}
          active={hidden === "all"}
          icon={hidden === "none" ? <Eye className="size-3.5" aria-hidden /> : <EyeOff className="size-3.5" aria-hidden />}
          onClick={(event) => {
            event.stopPropagation();
            api.toggleHide(node);
          }}
          {...stop}
        />
      </span>
    </>
  ) : null;

  return (
    <TreeRow
      label={node.label}
      labelContent={
        editing ? (
          <InlineRename node={node} api={api} onError={(reason, id) => setRenameError(reason ? { reason, id } : null)} />
        ) : (
          <Highlighted text={node.label} ranges={highlightRanges(node, query)} />
        )
      }
      tip={editing ? undefined : tip}
      secondary={stash ? `${stash.branch ?? t("sidebar.noBranch")} · ${formatRelative(stash.createdAt)}` : undefined}
      icon={icon}
      depth={depth}
      active={(ref?.isHead ?? false) || node.kind === "head"}
      selected={selected}
      focusable={focusable}
      expanded={expanded}
      arrowSpace={gutter}
      ahead={sync?.ahead}
      behind={sync?.behind}
      outgoing={sync?.outgoing}
      syncTip={sync?.tip}

      hidden={dimmed}
      solo={solo === "all"}
      dragging={dragging}
      dropTarget={dropTarget}
      meta={meta}
      trailing={trailing}
      trailingPinned
      aria-label={describe(node, hidden, solo)}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      data-row-id={node.id}
      data-kind={node.kind}
      // Pointer or keyboard focus on a branch highlights its commits in the graph (useBranchHover).
      data-ref-hover={ref && (node.kind === "branch" || node.kind === "remote_branch") ? ref.fullName : undefined}
      data-hidden={hidden === "all" ? "" : undefined}
      data-solo={solo === "all" ? "" : undefined}
      data-dragging={dragging ? "" : undefined}
      data-drop-target={dropTarget ? "" : undefined}
      className={cn("scroll-mt-control-md", editing && "z-20")}
    />
  );
}

export const RefRow = memo(RefRowInner);
