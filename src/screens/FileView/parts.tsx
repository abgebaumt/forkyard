/**
 * Small building blocks shared by file view, history and blame:
 * title with file name and folder, badges, separator, loading skeleton for code, back button.
 */
import { ArrowLeft, X } from "lucide-react";
import type { ReactNode } from "react";
import type { Id } from "../../core";
import { IconButton } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { Tip } from "../../ui/Tooltip";
import { backLabel, goBack, useBackTarget } from "./nav";
import { t } from "../../i18n";

export function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) } : { dir: "", name: path };
}

export function Divider() {
  return <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />;
}

/** Small badge in the header (revision, encoding, “editable”). */
export function Tag({ children, title, tone = "muted", className, ...rest }: { children: ReactNode; title?: string; tone?: "muted" | "accent" | "warning"; className?: string } & Record<`data-${string}`, string | undefined>) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border px-1.5 text-xs font-medium whitespace-nowrap",
        tone === "accent" ? "border-accent bg-accent-surface text-accent" : tone === "warning" ? "border-warning bg-warning-surface text-text" : "border-border text-text-muted",
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}

/** File name first, folder muted behind it; the full path in the tooltip. */
export function FileTitle({ path, icon, prefix, strike = false }: { path: string; icon?: ReactNode; prefix?: string; strike?: boolean }) {
  const { dir, name } = splitPath(path);
  return (
    <Tip label={<span className="font-mono text-code break-all">{path}</span>}>
      <h2 data-file-title="" className="m-0 flex min-w-0 flex-1 items-baseline gap-2 text-base font-normal">
        {icon ? <span className="flex shrink-0 self-center text-text-muted">{icon}</span> : null}
        {prefix ? <span className="shrink-0 text-sm font-medium text-text-muted">{prefix}</span> : null}
        <span className={cn("min-w-8 shrink truncate font-medium text-text", strike && "line-through")}>{name}</span>
        {dir ? <span className="min-w-0 shrink-4 truncate text-sm text-text-muted">{dir}</span> : null}
      </h2>
    </Tip>
  );
}

/** Close or go back to the view you came from (Esc). */
export function BackButton({ tabId, onClick }: { tabId: Id; onClick?: () => void }) {
  const target = useBackTarget(tabId);
  const label = target ? backLabel(target) : t("fileView.close");
  return (
    <IconButton
      size="sm"
      label={label}
      shortcut="Escape"
      data-back=""
      icon={target ? <ArrowLeft className="size-icon" aria-hidden /> : <X className="size-icon" aria-hidden />}
      onClick={onClick ?? (() => goBack(tabId))}
    />
  );
}

const SKELETON_WIDTHS = ["w-2/5", "w-3/4", "w-11/12", "w-1/2", "w-4/5", "w-2/3", "w-5/6", "w-1/3", "w-3/5", "w-11/12", "w-1/2", "w-3/4"];

/** Code lines hinted in grey while the content loads. */
export function CodeSkeleton({ label, gutter = false }: { label: string; gutter?: boolean }) {
  return (
    <div role="status" aria-label={label} data-loading="" className="flex h-full min-h-0 flex-col gap-2.5 overflow-hidden bg-surface-sunken px-4 py-3">
      {SKELETON_WIDTHS.map((width, index) => (
        <div key={index} className="flex items-center gap-4">
          {gutter ? <div className="h-3 w-48 shrink-0 animate-pulse rounded-sm bg-surface-raised" /> : null}
          <div className="h-3 w-6 shrink-0 animate-pulse rounded-sm bg-surface-raised" />
          <div className={cn("h-3 animate-pulse rounded-sm bg-surface-raised", width)} />
        </div>
      ))}
    </div>
  );
}

/**
 * Esc without modifier keys that nobody has consumed yet. An open tooltip consumes Esc (it closes
 * with it) – that does not count here: someone who has tabbed onto a button should be able to
 * leave the view with a single Esc.
 */
export function isPlainEscape(event: KeyboardEvent): boolean {
  if (event.key !== "Escape" || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  if (!event.defaultPrevented) return true;
  return Boolean(document.querySelector('[role="tooltip"]')) && !document.querySelector('[role="menu"], [role="dialog"], [role="alertdialog"]');
}

const isTextField =(element: Element | null) => Boolean(element && (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.tagName === "SELECT"));

/**
 * Whether a key press belongs to the view: not in text fields, menus, dialogs; not while a
 * dialog, an overlay or a menu is open.
 */
export function ownsKey(event: KeyboardEvent, blocked: boolean): boolean {
  if (blocked) return false;
  const target = event.target instanceof Element ? event.target : null;
  if (isTextField(target)) return false;
  if (target?.closest('[role="menu"], [role="dialog"], [role="listbox"][data-radix-select-viewport], .cm-panels')) return false;
  return true;
}
