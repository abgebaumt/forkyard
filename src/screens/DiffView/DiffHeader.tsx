/**
 * Header of the diff view, two rows:
 *   1  status, file name, origin, +/−  ·  previous/next file  ·  history, blame, edit  ·  close
 *   2  view toggle  ·  previous/next change  ·  line wrapping, whitespace, collapse regions
 * At a window width of 960 px a good 500 px remain for the middle – hence icons with tooltips instead of text.
 */
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ExternalLink, FoldVertical, History, Pencil, Space, UnfoldVertical, UserSearch, WrapText, X } from "lucide-react";
import { EMPTY_TREE_SHA, type DiffMode, type DiffSource, type FileStatus } from "../../core";
import { shortSha } from "../../app/format";
import { IconButton } from "../../ui/Button";
import { SegmentedControl } from "../../ui/Field";
import { StatusBadge } from "../../ui/Git";
import { Tip } from "../../ui/Tooltip";
import { modeLabels } from "./actions";
import { splitPath } from "./model";
import { locale, t } from "../../i18n";

export interface DiffHeaderProps {
  path: string;
  oldPath: string | null;
  status: FileStatus | null;
  source: DiffSource;
  added: number | null;
  removed: number | null;
  /** Detected encoding, if not UTF-8. */
  encoding: string | null;

  mode: DiffMode;
  onMode: (mode: DiffMode) => void;
  wrap: boolean;
  onWrap: (wrap: boolean) => void;
  ignoreWhitespace: boolean;
  onIgnoreWhitespace: (ignore: boolean) => void;
  /** The view toggles only apply to text diffs. */
  textual: boolean;

  /** Number of change blocks and the current one (−1 = none). */
  changeCount: number;
  changeIndex: number;
  onChange: (direction: 1 | -1) => void;

  fileIndex: number;
  fileCount: number;
  onFile: (direction: 1 | -1) => void;

  /** Only in “Whole file”: collapse and expand unchanged regions all at once. */
  fold: { collapsed: boolean; onToggle: () => void } | null;

  onHistory: () => void;
  onBlame: () => void;
  /** null: editing is not available here (no working directory). */
  onEdit: (() => void) | null;
  /** Show the same comparison in the external diff tool; if there is none, there is no button. */
  onExternalDiff?: (() => void) | null;
  onClose: () => void;
  /** Embedded (file history): without file switching, history and close. */
  embedded?: boolean;
}

const sourceLabel = (source: DiffSource): string => {
  switch (source.kind) {
    case "unstaged":
      return t("diff.source.unstaged");
    case "staged":
      return t("diff.source.staged");
    case "commit":
      return t("diff.source.commit", { sha: shortSha(source.sha) });
    case "range":
      // Sequence from the first commit: the comparison is against the empty tree – its SHA means nothing to anyone.
      if (source.from === EMPTY_TREE_SHA) return source.to ? t("diff.source.startTo", { to: shortSha(source.to) }) : t("diff.source.startToWorktree");
      return source.to ? `${shortSha(source.from)} … ${shortSha(source.to)}` : t("diff.source.toWorktree", { from: shortSha(source.from) });
    case "stash":
      return t("diff.source.stash", { index: source.index });
  }
};

const modes: DiffMode[] = ["hunks", "inline", "split"];

function Divider() {
  return <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />;
}

function Tag({ children, title }: { children: string; title?: string }) {
  return (
    <span title={title} className="shrink-0 rounded-sm border border-border px-1.5 text-xs font-medium whitespace-nowrap text-text-muted">
      {children}
    </span>
  );
}

export function DiffHeader(props: DiffHeaderProps) {
  const { path, oldPath, status, source, added, removed, encoding, mode, textual, changeCount, changeIndex, fileIndex, fileCount } = props;
  const { dir, name } = splitPath(path);
  const fullPath = oldPath && oldPath !== path ? `${oldPath} → ${path}` : path;
  const hasChanges = textual && changeCount > 0;

  return (
    <header data-diff-header="" className="shrink-0 border-b border-border bg-surface">
      <div className="flex h-control-lg items-center gap-2 pr-1 pl-3">
        {status ? <StatusBadge status={status} /> : null}
        <Tip label={<span className="font-mono text-code break-all">{fullPath}</span>}>
          <h2 data-diff-title="" className="m-0 flex min-w-0 flex-1 items-baseline gap-2 text-base font-normal">
            <span className={status === "deleted" ? "min-w-8 shrink truncate font-medium text-text line-through" : "min-w-8 shrink truncate font-medium text-text"}>{name}</span>
            {dir ? <span className="min-w-0 shrink-4 truncate text-sm text-text-muted">{dir}</span> : null}
            {oldPath && oldPath !== path ? <span className="min-w-0 shrink-8 truncate text-sm text-text-muted">{t("diff.header.formerly", { path: oldPath })}</span> : null}
          </h2>
        </Tip>
        {encoding ? <Tag title={t("diff.header.encoding")}>{encoding}</Tag> : null}
        {/* For text diffs the origin is in the second row – this leaves room for the name at the top. */}
        {!textual ? <Tag>{sourceLabel(source)}</Tag> : null}
        {added || removed ? (
          <span className="flex shrink-0 gap-1.5 font-mono text-code tabular-nums" aria-label={t("diff.header.counts", { count: added ?? 0, added: (added ?? 0).toLocaleString(locale()), removed: (removed ?? 0).toLocaleString(locale()) })} data-diff-counts="">
            {added ? <span className="text-success">+{added}</span> : null}
            {removed ? <span className="text-danger">−{removed}</span> : null}
          </span>
        ) : null}
        {props.embedded ? null : <Divider />}
        {props.embedded ? null : <div role="group" aria-label={t("diff.header.switchFile")} className="flex shrink-0 items-center">
          <IconButton size="sm" label={t("diff.header.prevFile")} shortcut="Alt+ArrowLeft" disabled={fileIndex <= 0} icon={<ChevronLeft className="size-icon" aria-hidden />} onClick={() => props.onFile(-1)} />
          <span className="min-w-8 px-0.5 text-center text-xs text-text-muted tabular-nums" aria-label={fileIndex >= 0 ? t("diff.header.filePosition", { index: fileIndex + 1, total: fileCount }) : undefined}>
            {fileIndex >= 0 ? `${fileIndex + 1}/${fileCount}` : "–"}
          </span>
          <IconButton
            size="sm"
            label={t("diff.header.nextFile")}
            shortcut="Alt+ArrowRight"
            disabled={fileCount === 0 || fileIndex >= fileCount - 1}
            icon={<ChevronRight className="size-icon" aria-hidden />}
            onClick={() => props.onFile(1)}
          />
        </div>}
        <Divider />
        {props.embedded ? null : <IconButton size="sm" label={t("diff.header.history")} icon={<History className="size-icon" aria-hidden />} onClick={props.onHistory} />}
        <IconButton size="sm" label={t("diff.header.blame")} icon={<UserSearch className="size-icon" aria-hidden />} onClick={props.onBlame} />
        {props.onEdit ? <IconButton size="sm" label={t("diff.header.edit")} icon={<Pencil className="size-icon" aria-hidden />} onClick={props.onEdit} /> : null}
        {props.onExternalDiff ? (
          <IconButton size="sm" label={t("diff.header.externalDiff")} data-action="external-diff" icon={<ExternalLink className="size-icon" aria-hidden />} onClick={props.onExternalDiff} />
        ) : null}
        {props.embedded ? null : <Divider />}
        {props.embedded ? null : <IconButton size="sm" label={t("diff.header.close")} shortcut="Escape" icon={<X className="size-icon" aria-hidden />} onClick={props.onClose} />}
      </div>

      {textual ? (
        <div role="toolbar" aria-label={t("diff.header.toolbar")} className="flex h-control-lg items-center gap-1 border-t border-border pr-1 pl-3">
          <SegmentedControl label={t("diff.header.mode")} value={mode} options={modes.map((value) => ({ value, label: modeLabels[value] }))} onValueChange={props.onMode} />
          <span className="min-w-0 flex-1 pl-2">
            {/* When embedded (file history), the host already names the commit directly above. */}
            {props.embedded ? null : (
              <span className="inline-block max-w-full truncate align-middle">
                <Tag>{sourceLabel(source)}</Tag>
              </span>
            )}
          </span>
          <div role="group" aria-label={t("diff.header.switchChange")} className="flex shrink-0 items-center">
            <IconButton size="sm" label={t("diff.header.prevChange")} shortcut="Shift+F7" disabled={!hasChanges} icon={<ChevronUp className="size-icon" aria-hidden />} onClick={() => props.onChange(-1)} />
            <span className="min-w-8 px-0.5 text-center text-xs text-text-muted tabular-nums" data-change-position="" aria-label={hasChanges && changeIndex >= 0 ? t("diff.header.changePosition", { index: changeIndex + 1, total: changeCount }) : undefined}>
              {!hasChanges ? "–" : mode === "split" || changeIndex < 0 ? `${changeCount}` : `${changeIndex + 1}/${changeCount}`}
            </span>
            <IconButton size="sm" label={t("diff.header.nextChange")} shortcut="F7" disabled={!hasChanges} icon={<ChevronDown className="size-icon" aria-hidden />} onClick={() => props.onChange(1)} />
          </div>
          <Divider />
          {props.fold ? (
            <IconButton
              size="sm"
              label={props.fold.collapsed ? t("diff.header.unfold") : t("diff.header.fold")}
              active={props.fold.collapsed}
              icon={props.fold.collapsed ? <UnfoldVertical className="size-icon" aria-hidden /> : <FoldVertical className="size-icon" aria-hidden />}
              onClick={props.fold.onToggle}
            />
          ) : null}
          <IconButton size="sm" label={t("diff.header.wrap")} active={props.wrap} aria-pressed={props.wrap} icon={<WrapText className="size-icon" aria-hidden />} onClick={() => props.onWrap(!props.wrap)} />
          <IconButton
            size="sm"
            label={mode === "split" ? t("diff.header.ignoreWhitespaceSplit") : t("diff.header.ignoreWhitespace")}
            active={props.ignoreWhitespace && mode !== "split"}
            aria-pressed={props.ignoreWhitespace}
            aria-disabled={mode === "split" || undefined}
            className={mode === "split" ? "text-text-disabled hover:bg-transparent hover:text-text-disabled" : undefined}
            icon={<Space className="size-icon" aria-hidden />}
            onClick={() => {
              if (mode !== "split") props.onIgnoreWhitespace(!props.ignoreWhitespace);
            }}
          />
        </div>
      ) : null}
    </header>
  );
}
