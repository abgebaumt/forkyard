import { createContext, useContext, useState, type ComponentProps, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, ChevronRight, Cloud, GitBranch, Tag } from "lucide-react";
import { Collapsible } from "radix-ui";
import { cn, laneColor } from "./cn";
import { Tip } from "./Tooltip";
import { t } from "../i18n";

// ---------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "?";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

function hash(text: string): number {
  let value = 0;
  for (let index = 0; index < text.length; index++) value = (value * 31 + text.charCodeAt(index)) | 0;
  return Math.abs(value);
}

/** Initials on a lane colour. The same person always gets the same colour. */
/** Returns the URL of an image for an email address (or null). The app provides it. */
export type AvatarSource = (email: string | undefined) => string | null;
export const AvatarSourceContext = createContext<AvatarSource>(() => null);

export function Avatar({ name, email, size = 20 }: { name: string; email?: string; size?: number }) {
  const image = useContext(AvatarSourceContext)(email);
  const [failed, setFailed] = useState<string | null>(null);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.45), background: laneColor(hash(email ?? name)) };
  const title = email ? `${name} <${email}>` : name;
  if (image && failed !== image) {
    return <img src={image} alt="" aria-hidden title={title} width={size} height={size} className="shrink-0 rounded-pill object-cover" style={style} onError={() => setFailed(image)} />;
  }
  return (
    <span title={title} aria-hidden className="inline-flex shrink-0 items-center justify-center rounded-pill font-semibold text-on-lane" style={style}>
      {initials(name)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Ref label
// ---------------------------------------------------------------------------

export type RefKind = "local" | "remote" | "tag";

export interface RefLabelProps {
  kind: RefKind;
  name: string;
  lane?: number;
  /** The checked-out branch. */
  head?: boolean;
  /** Target while dragging another branch. */
  dropTarget?: boolean;
  dimmed?: boolean;
}

const refIcon: Record<RefKind, ReactNode> = {
  local: <GitBranch className="size-3" aria-hidden />,
  remote: <Cloud className="size-3" aria-hidden />,
  tag: <Tag className="size-3" aria-hidden />,
};

const refKindText: Record<RefKind, string> = {
  local: t("ui.ref.local"),
  remote: t("ui.ref.remote"),
  tag: t("ui.ref.tag"),
};

/**
 * Branch or tag marker on the graph. The kind can be recognised by the icon and the shape,
 * not only by the colour: local filled, remote outlined, tag neutral.
 */
export function RefLabel({ kind, name, lane = 0, head, dropTarget, dimmed }: RefLabelProps) {
  const color = laneColor(lane);
  return (
    <span
      title={t(head ? "ui.ref.titleHead" : "ui.ref.title", { kind: refKindText[kind], name })}
      className={cn(
        "inline-flex h-4.5 max-w-44 shrink-0 items-center gap-1 rounded-sm border px-1.5 text-xs font-medium",
        kind === "local" && "text-on-lane",
        kind === "remote" && "bg-surface text-text",
        kind === "tag" && "border-border-input bg-surface-raised text-text",
        dropTarget && "outline-2 outline-offset-1 outline-accent",
        dimmed && "opacity-40",
      )}
      style={
        kind === "local"
          ? { background: color, borderColor: color }
          : kind === "remote"
            ? { borderColor: color }
            : undefined
      }
    >
      {head ? <Check className="size-3" strokeWidth={3} aria-hidden /> : refIcon[kind]}
      <span className="truncate">{name}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// File row
// ---------------------------------------------------------------------------

export type FileStatus = "modified" | "added" | "deleted" | "renamed" | "conflicted" | "untracked";

const statusMeta: Record<FileStatus, { letter: string; label: string; className: string }> = {
  modified: { letter: "M", label: t("ui.fileStatus.modified"), className: "text-warning" },
  added: { letter: "A", label: t("ui.fileStatus.added"), className: "text-success" },
  deleted: { letter: "D", label: t("ui.fileStatus.deleted"), className: "text-danger" },
  renamed: { letter: "R", label: t("ui.fileStatus.renamed"), className: "text-accent" },
  conflicted: { letter: "!", label: t("ui.fileStatus.conflicted"), className: "text-danger" },
  untracked: { letter: "U", label: t("ui.fileStatus.untracked"), className: "text-text-muted" },
};

/** Status as a letter plus colour – never colour alone. */
export function StatusBadge({ status }: { status: FileStatus }) {
  const meta = statusMeta[status];
  return (
    <span
      title={meta.label}
      className={cn("inline-flex w-4 shrink-0 justify-center font-mono text-code font-bold", meta.className)}
    >
      <span aria-hidden>{meta.letter}</span>
      <span className="sr-only">{meta.label}</span>
    </span>
  );
}

export interface FileRowProps {
  path: string;
  status: FileStatus;
  /** For renames, the old path. */
  oldPath?: string;
  selected?: boolean;
  lfs?: boolean;
  additions?: number;
  deletions?: number;
  /** Action that appears on hover, e.g. the stage button. */
  action?: ReactNode;
  onSelect?: () => void;
}

export function FileRow({ path, status, oldPath, selected, lfs, additions, deletions, action, onSelect }: FileRowProps) {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const file = slash >= 0 ? path.slice(slash + 1) : path;
  return (
    <div
      role="option"
      aria-selected={selected ?? false}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      className={cn(
        "group flex h-row items-center gap-2 px-2 text-base",
        selected ? "bg-accent-surface" : "hover:bg-surface-raised",
      )}
    >
      <StatusBadge status={status} />
      <span className="min-w-0 flex-1 truncate" title={oldPath ? `${oldPath} → ${path}` : path}>
        <span className={cn(status === "deleted" && "line-through")}>{file}</span>
        {dir ? <span className="ml-2 text-sm text-text-muted">{dir}</span> : null}
      </span>
      {lfs ? (
        <span className="rounded-sm border border-border-input px-1 text-xs font-medium text-text-muted">LFS</span>
      ) : null}
      {additions !== undefined || deletions !== undefined ? (
        <span className="shrink-0 font-mono text-xs group-hover:hidden">
          {additions ? <span className="text-success">+{additions}</span> : null}
          {additions && deletions ? " " : null}
          {deletions ? <span className="text-danger">−{deletions}</span> : null}
        </span>
      ) : null}
      {action ? (
        <span className="hidden shrink-0 group-focus-within:inline-flex group-hover:inline-flex">{action}</span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Left panel: section and tree row
// ---------------------------------------------------------------------------

export interface PanelSectionProps extends Omit<ComponentProps<"div">, "title" | "children"> {
  title: string;
  /** Small icon before the title. */
  icon?: ReactNode;
  /** Count; when filtering also a short text like "3/12". */
  count?: number | string;
  defaultOpen?: boolean;
  /** Controlled: open or collapsed. If omitted, the section remembers its state itself. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Double click on the header, e.g. to maximise. */
  onHeaderDoubleClick?: () => void;
  /** Actions on the right of the header, visible on hover or focus. */
  actions?: ReactNode;
  /** On the right of the header, always visible – e.g. a toggle that is switched on. */
  pinnedActions?: ReactNode;
  /** The header stays at the top while scrolling. */
  stickyHeader?: boolean;
  children: ReactNode;
}

export function PanelSection({
  title,
  icon,
  count,
  defaultOpen = true,
  open,
  onOpenChange,
  onHeaderDoubleClick,
  actions,
  pinnedActions,
  stickyHeader,
  className,
  children,
  ...rest
}: PanelSectionProps) {
  return (
    <Collapsible.Root
      {...rest}
      {...(open === undefined ? { defaultOpen } : { open })}
      onOpenChange={onOpenChange}
      className={cn("border-b border-border", className)}
    >
      <div data-section-header className={cn("group relative flex h-control-lg items-center pr-1", stickyHeader && "sticky top-0 z-10 bg-surface")}>
        <Collapsible.Trigger
          onDoubleClick={onHeaderDoubleClick}
          className="group/trigger flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-xs font-semibold tracking-wide text-text-muted uppercase -outline-offset-2 hover:text-text"
        >
          <ChevronRight
            className="size-3.5 shrink-0 transition-transform group-data-[state=open]/trigger:rotate-90"
            aria-hidden
          />
          {icon ? <span className="flex shrink-0 [&>svg]:size-3.5">{icon}</span> : null}
          <span className="truncate">{title}</span>
          <span className="flex-1" />
          {count !== undefined ? <span className="shrink-0 rounded-pill bg-surface-raised px-1.5 text-xs font-medium tabular-nums">{count}</span> : null}
        </Collapsible.Trigger>
        {actions ? (
          // Over the right edge (and the count) instead of beside it, so every count lines up.
          <div className="pointer-events-none absolute inset-y-0 right-1 flex items-center bg-surface opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">{actions}</div>
        ) : null}
        {pinnedActions ? <div className="flex">{pinnedActions}</div> : null}
      </div>
      <Collapsible.Content className="pb-1">{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}

export interface TreeRowProps extends Omit<ComponentProps<"div">, "children" | "hidden"> {
  label: string;
  /** Replaces the display of the name (match highlighting, inline input). */
  labelContent?: ReactNode;
  /** Tooltip on the name: full name, annotation of a tag, URL of a remote. */
  tip?: ReactNode;
  /** Second, muted line below the name (stash: branch and date). The row then becomes taller. */
  secondary?: ReactNode;
  icon?: ReactNode;
  depth?: number;
  /** The checked-out branch. */
  active?: boolean;
  selected?: boolean;
  /** Roving tabindex: exactly one row of the tree is reachable by Tab. If omitted, it is the selected one. */
  focusable?: boolean;
  /** Folders and remotes: shows the arrow and sets aria-expanded. If omitted, the row is a leaf. */
  expanded?: boolean;
  /** Leaf next to folders: leaves the arrow's space free so the icons of one level line up. */
  arrowSpace?: boolean;
  ahead?: number;
  behind?: number;
  /** Pending push even without commits (a branch not on the remote yet): the up arrow shows at 0 too. */
  outgoing?: boolean;
  /** Tooltip on the counters, e.g. "2 commits ahead of, 3 behind origin/main". */
  syncTip?: string;
  /** Hidden in the graph. */
  hidden?: boolean;
  /** The graph shows only this entry (and others with solo). */
  solo?: boolean;
  /** Currently being dragged. */
  dragging?: boolean;
  /** Target while dragging another branch. */
  dropTarget?: boolean;
  /** Extra text between name and counters, always visible (e.g. "Upstream missing"). */
  meta?: ReactNode;
  /**
   * The name keeps its natural width, and `meta` gets the rest of the row (instead of the other way round).
   * For rows whose details next to it matter as much as the name (worktrees: branch and state).
   */
  metaFills?: boolean;
  trailing?: ReactNode;
  /** Always show `trailing` instead of only on hover or focus. */
  trailingPinned?: boolean;
}

export function TreeRow({
  label,
  labelContent,
  tip,
  secondary,
  icon,
  depth = 0,
  active,
  selected,
  focusable,
  expanded,
  arrowSpace,
  ahead,
  behind,
  outgoing,
  syncTip,
  hidden,
  solo,
  dragging,
  dropTarget,
  meta,
  metaFills,
  trailing,
  trailingPinned,
  className,
  style,
  ...rest
}: TreeRowProps) {
  const name = (
    <span className={cn("block truncate", active && "font-semibold", solo && "font-medium text-accent")}>{labelContent ?? label}</span>
  );
  const counters =
    behind || ahead || outgoing ? (
      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-text-muted tabular-nums">
        {/* Same order as in the status bar: ahead first, then behind. */}
        {ahead || outgoing ? (
          <span className="inline-flex items-center" data-outgoing={outgoing ? "" : undefined}>
            <ArrowUp className="size-3" aria-hidden />
            {ahead || null}
          </span>
        ) : null}

        {behind ? (
          <span className="inline-flex items-center">
            <ArrowDown className="size-3" aria-hidden />
            {behind}
          </span>
        ) : null}
      </span>
    ) : null;
  const fallbackSyncTip = [ahead ? t("ui.sync.ahead", { n: ahead }) : null, behind ? t("ui.sync.behind", { n: behind }) : null].filter(Boolean).join(", ");
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected ?? false}
      aria-current={active ? "true" : undefined}
      aria-expanded={expanded}
      tabIndex={(focusable ?? selected) ? 0 : -1}
      {...rest}
      className={cn(
        "group relative flex items-center gap-1.5 pr-1 text-base -outline-offset-2",
        secondary ? "h-10" : "h-row",
        dropTarget ? "bg-accent-surface outline-2 outline-accent" : selected ? "bg-accent-surface" : "hover:bg-surface-raised",
        hidden && "text-text-disabled",
        dragging && "opacity-60",
        className,
      )}
      style={{ paddingLeft: 18 + depth * 14, ...style }}
    >
      {expanded !== undefined ? (
        <span className="flex size-3 shrink-0 items-center justify-center text-text-muted" aria-hidden>
          <ChevronRight className={cn("size-3 transition-transform", expanded && "rotate-90")} />
        </span>
      ) : arrowSpace ? (
        <span className="size-3 shrink-0" aria-hidden />
      ) : null}
      <span
        className={cn(
          "flex size-icon shrink-0 items-center justify-center",
          active || solo ? "text-accent" : hidden ? "text-text-disabled" : "text-text-muted",
        )}
      >
        {active ? <Check className="size-3.5" strokeWidth={3} aria-hidden /> : icon}
      </span>
      <span className={cn("min-w-0", metaFills ? "shrink" : "flex-1")}>
        {tip ? (
          <Tip label={tip} side="right">
            {name}
          </Tip>
        ) : (
          name
        )}
        {secondary ? <span className="block truncate text-xs text-text-muted">{secondary}</span> : null}
      </span>
      {meta}
      {counters ? (
        <Tip label={syncTip ?? fallbackSyncTip} side="right">
          {counters}
        </Tip>
      ) : null}
      {trailing ? (
        <span className={cn("shrink-0", trailingPinned ? "inline-flex" : "hidden group-focus-within:inline-flex group-hover:inline-flex")}>
          {trailing}
        </span>
      ) : null}
    </div>
  );
}
