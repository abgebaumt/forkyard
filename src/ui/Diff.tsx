import type { ReactNode } from "react";
import { cn } from "./cn";
import { t } from "../i18n";

export type DiffLineKind = "context" | "add" | "remove";

export interface DiffSegment {
  text: string;
  /** Part changed within the line (word diff). */
  changed?: boolean;
}

export interface DiffLine {
  kind: DiffLineKind;
  oldNo?: number;
  newNo?: number;
  segments: DiffSegment[];
  selected?: boolean;
}

const rowTone: Record<DiffLineKind, string> = {
  context: "",
  add: "bg-diff-added",
  remove: "bg-diff-removed",
};

const strongTone: Record<DiffLineKind, string> = {
  context: "",
  add: "bg-diff-added-strong",
  remove: "bg-diff-removed-strong",
};

// The sign is always shown: added and removed lines can be told apart without colour.
const sign: Record<DiffLineKind, string> = { context: " ", add: "+", remove: "−" };
const signLabel: Record<DiffLineKind, string> = { context: "", add: t("ui.diff.added"), remove: t("ui.diff.removed") };

export interface DiffHunkProps {
  /** e.g. "@@ -12,7 +12,9 @@ fn build_patch" */
  header: string;
  lines: DiffLine[];
  /** Buttons in the header: stage hunk, discard. */
  actions?: ReactNode;
}

/**
 * A hunk in the single-column view. In the app CodeMirror renders the
 * actual diff; this building block defines colours, grid and states.
 */
export function DiffHunk({ header, lines, actions }: DiffHunkProps) {
  return (
    <section className="overflow-hidden rounded-md border border-border bg-surface-sunken">
      <header className="flex h-control-md items-center gap-2 border-b border-border bg-surface px-2">
        <code className="min-w-0 flex-1 truncate font-mono text-code text-text-muted">{header}</code>
        {actions}
      </header>
      <div role="table" aria-label={t("ui.diff.lines")} className="selectable font-mono text-code">
        {lines.map((line, index) => (
          <div
            key={index}
            role="row"
            aria-selected={line.selected || undefined}
            className={cn(
              "flex",
              rowTone[line.kind],
              line.selected && "shadow-[inset_2px_0_0_var(--gc-accent)]",
            )}
          >
            <span role="cell" className="w-10 shrink-0 px-1 text-right text-text-muted select-none">
              {line.oldNo ?? ""}
            </span>
            <span role="cell" className="w-10 shrink-0 px-1 text-right text-text-muted select-none">
              {line.newNo ?? ""}
            </span>
            <span role="cell" className="w-4 shrink-0 text-center text-text-muted select-none">
              <span aria-hidden>{sign[line.kind]}</span>
              <span className="sr-only">{signLabel[line.kind]}</span>
            </span>
            <span role="cell" className="min-w-0 flex-1 pr-2 whitespace-pre-wrap text-text">
              {line.segments.map((segment, segmentIndex) =>
                segment.changed ? (
                  <mark key={segmentIndex} className={cn("rounded-sm text-text", strongTone[line.kind])}>
                    {segment.text}
                  </mark>
                ) : (
                  <span key={segmentIndex}>{segment.text}</span>
                ),
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
