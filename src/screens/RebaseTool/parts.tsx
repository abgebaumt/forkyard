/**
 * Building blocks shared by all three modes of the rebase tool: header, column row, footer,
 * loading skeleton, states (rejected, error, empty) and the columns of a commit row.
 */
import { useEffect, useRef, type MutableRefObject, type ReactNode } from "react";
import { ArrowDownNarrowWide, X } from "lucide-react";
import type { CoreError } from "../../core";
import { describeError } from "../../app/errors";
import { formatDate, formatDateTime, shortSha } from "../../app/format";
import { Button, IconButton } from "../../ui/Button";
import { Avatar } from "../../ui/Git";
import { Kbd } from "../../ui/Kbd";
import { Tip } from "../../ui/Tooltip";
import type { DateFormat } from "../../core";
import { t } from "../../i18n";

/** Passed down by the tool: the mode registers here what Ctrl+Enter starts (null = nothing right now). */
export type StartRef = MutableRefObject<(() => void) | null>;

export function ToolHeader({ icon, title, subtitle, onClose }: { icon: ReactNode; title: string; subtitle?: ReactNode; onClose: () => void }) {
  return (
    <header className="flex h-control-lg shrink-0 items-center gap-2 border-b border-border bg-surface pr-1 pl-3">
      <span className="flex shrink-0 text-text-muted">{icon}</span>
      <h2 className="m-0 shrink-0 text-base font-semibold text-text">{title}</h2>
      {subtitle ? <div className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm text-text-muted">{subtitle}</div> : <span className="flex-1" />}
      <IconButton size="sm" label={t("rebase.closeWithoutChanges")} shortcut="Escape" icon={<X className="size-icon" aria-hidden />} onClick={onClose} />
    </header>
  );
}

/** A name in the header: branch or commit, highlighted. */
export function Name({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
  return <span className={mono ? "shrink-0 font-mono text-code text-text" : "min-w-0 truncate font-medium text-text"}>{children}</span>;
}

/** Row above the list: direction and column names. For screen readers the direction is in the list's name. */
export function ColumnBar({ direction, lead }: { direction: string; lead: ReactNode }) {
  return (
    // Same reserved margin as the list below (scrollbar), so the columns line up.
    <div aria-hidden className="flex h-row shrink-0 items-center gap-2 overflow-hidden border-b border-border bg-surface pr-3 text-xs font-semibold tracking-wide text-text-muted uppercase [scrollbar-gutter:stable]">
      {lead}
      <span className="flex min-w-0 flex-1 items-center gap-1 normal-case">
        <ArrowDownNarrowWide className="size-icon shrink-0" aria-hidden />
        <span className="truncate font-medium tracking-normal">{direction}</span>
      </span>
      <span className="hidden w-36 shrink-0 @2xl:block">{t("rebase.column.author")}</span>
      <span className="hidden w-24 shrink-0 text-right @xl:block">{t("rebase.column.date")}</span>
      <span className="w-16 shrink-0 text-right">SHA</span>
    </div>
  );
}

export interface CommitCellsProps {
  authorName: string;
  authorEmail: string;
  authoredAt: string | null;
  sha: string;
  dateFormat: DateFormat;
  dimmed?: boolean;
}

/** Author, date, SHA on the right of the row. Author and date give way in a narrow centre. */
export function CommitCells({ authorName, authorEmail, authoredAt, sha, dateFormat, dimmed }: CommitCellsProps) {
  return (
    <>
      <span className={dimmed ? "hidden w-36 shrink-0 items-center gap-1.5 opacity-60 @2xl:flex" : "hidden w-36 shrink-0 items-center gap-1.5 @2xl:flex"}>
        <Avatar name={authorName} email={authorEmail} size={18} />
        <span className="min-w-0 truncate text-sm text-text-muted">{authorName}</span>
      </span>
      <span className="hidden w-24 shrink-0 truncate text-right text-sm text-text-muted @xl:block" title={authoredAt ? formatDateTime(authoredAt) : undefined}>
        {authoredAt ? formatDate(authoredAt, dateFormat) : ""}
      </span>
      <span className="selectable w-16 shrink-0 text-right font-mono text-code text-text-muted">{shortSha(sha)}</span>
    </>
  );
}

/** Footer: on the left what happens (and the keys), on the right the buttons. */
export function ToolFooter({ info, keys, children }: { info: ReactNode; keys?: [string, string][]; children: ReactNode }) {
  return (
    <footer className="flex shrink-0 flex-col border-t border-border bg-surface">
      <div className="flex h-row items-center border-b border-border px-3 text-base text-text" data-plan-summary="">
        <div className="min-w-0 flex-1 truncate">{info}</div>
      </div>
      <div className="flex items-center gap-3 px-3 py-2">
        {keys?.length ? (
          // One line high, with wrapping: what no longer fits slips into the hidden second line instead of ending mid-word.
          <div className="hidden h-4 min-w-0 flex-1 flex-wrap items-center gap-x-3 overflow-hidden text-xs whitespace-nowrap text-text-muted @2xl:flex" aria-hidden>
            {keys.map(([key, label]) => (
              <span key={label} className="inline-flex shrink-0 items-center gap-1">
                {key.split(" ").map((part) => (
                  <Kbd key={part}>{part}</Kbd>
                ))}
                {label}
              </span>
            ))}
          </div>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>
      </div>
    </footer>
  );
}

/** Primary button that stays focusable when disabled and names the reason in the tooltip. */
export function StartButton({ label, blocked, loading, icon, onClick, action }: { label: string; blocked: string | null; loading: boolean; icon: ReactNode; onClick: () => void; action: string }) {
  return (
    <Tip label={blocked ?? label} shortcut={blocked ? undefined : "Mod+Enter"}>
      <Button
        variant="primary"
        icon={icon}
        loading={loading}
        data-action={action}
        data-blocked={blocked ? "" : undefined}
        {...(blocked ? { "aria-disabled": true, "aria-description": blocked } : {})}
        className="data-[blocked]:cursor-default data-[blocked]:bg-surface-raised data-[blocked]:text-text-disabled data-[blocked]:hover:brightness-100"
        onClick={() => {
          if (!blocked && !loading) onClick();
        }}
      >
        {label}
      </Button>
    </Tip>
  );
}

/** Placeholder rows while the plan loads. */
export function SkeletonRows({ rows = 8 }: { rows?: number }) {
  const widths = ["w-2/3", "w-1/2", "w-3/5", "w-2/5", "w-3/4", "w-1/3"];
  return (
    <div role="status" aria-label={t("rebase.loading")} className="flex flex-col" data-skeleton="">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex h-graph-row items-center gap-3 border-b border-border px-3">
          <span className="h-3 w-3 shrink-0 animate-pulse rounded-sm bg-surface-raised" />
          <span className="h-4 w-24 shrink-0 animate-pulse rounded-sm bg-surface-raised" />
          <span className="flex min-w-0 flex-1">
            <span className={`h-3 animate-pulse rounded-sm bg-surface-raised ${widths[index % widths.length]}`} />
          </span>
          <span className="hidden h-3 w-28 shrink-0 animate-pulse rounded-sm bg-surface-raised @2xl:block" />
          <span className="h-3 w-14 shrink-0 animate-pulse rounded-sm bg-surface-raised" />
        </div>
      ))}
    </div>
  );
}

/** Full-area state: rejected, error, empty. At most two actions. */
export function StatePanel({ icon, title, children, actions, state }: { icon: ReactNode; title: string; children?: ReactNode; actions?: ReactNode; state: string }) {
  const panel = useRef<HTMLDivElement>(null);
  // Focus goes to the main action (the last one) so the keyboard can continue right away –
  // but only if focus is free or was in the tool; whoever is typing elsewhere stays there.
  useEffect(() => {
    // "Free" also means: focus still hangs on the menu that opened the tool, on the graph row below
    // (which is about to disappear) or only on the region itself. That only settles after a few
    // frames – so we keep checking; if focus is then really elsewhere, it stays there.
    let frame = 0;
    let tries = 12;
    const target = () => panel.current?.querySelector<HTMLElement>("[data-panel-actions] > button:last-of-type") ?? null;
    const attempt = () => {
      const button = target();
      const active = document.activeElement;
      if (!button || active === button) return;
      const gone = active instanceof HTMLElement && (!active.isConnected || (typeof active.checkVisibility === "function" && !active.checkVisibility({ visibilityProperty: true })));
      const free = !active || active === document.body || gone || Boolean(active.closest('[data-screen="rebase"], [role="menu"]')) || active.matches('[data-area="center"]');
      if (free && !document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) {
        button.focus({ preventScroll: true });
        if (document.activeElement === button) return;
      }
      if (--tries > 0) frame = requestAnimationFrame(attempt);
    };
    attempt();
    return () => cancelAnimationFrame(frame);
  }, [state]);
  return (
    <div ref={panel} className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6" data-state-panel={state}>
      <div className="flex max-w-120 flex-col items-center gap-2 text-center">
        <span className="text-text-muted">{icon}</span>
        <h3 className="m-0 text-md font-semibold text-text">{title}</h3>
        {children ? <div className="selectable text-base text-text-muted">{children}</div> : null}
        {actions ? (
          <div data-panel-actions="" className="mt-2 flex flex-wrap justify-center gap-2">
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Error while loading – with reason and "Try again". */
export function LoadError({ error, onRetry, onClose, icon }: { error: CoreError; onRetry: () => void; onClose: () => void; icon: ReactNode }) {
  const { text, hint } = describeError(error);
  return (
    <StatePanel
      state="error"
      icon={icon}
      title={t("rebase.loadError.title")}
      actions={
        <>
          <Button onClick={onClose}>{t("rebase.backToGraph")}</Button>
          <Button variant="primary" onClick={onRetry}>
            {t("rebase.retry")}
          </Button>
        </>
      }
    >
      <p className="m-0">{text}</p>
      {hint ? <p className="m-0 mt-1">{hint}</p> : null}
    </StatePanel>
  );
}
