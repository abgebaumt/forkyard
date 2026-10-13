/**
 * Small building blocks of the commit panel: skeleton, error state, SHA with copy, person, date.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, RefreshCw, TriangleAlert } from "lucide-react";
import type { DateFormat, Person, Sha } from "../../core";
import { describeError, toCoreError } from "../../app/errors";
import { formatDate, formatDateTime, shortSha, UNKNOWN_DATE } from "../../app/format";
import { Button, IconButton } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { Avatar } from "../../ui/Git";
import { Tip } from "../../ui/Tooltip";
import { locale, t } from "../../i18n";

// ---------------------------------------------------------------------------
// Skelett
// ---------------------------------------------------------------------------

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn("block animate-pulse rounded-sm bg-surface-raised", className)} />;
}

const rowWidths = ["w-2/3", "w-1/2", "w-3/4", "w-2/5", "w-3/5", "w-1/2"];

/** Placeholder rows for a list that is loading. */
export function SkeletonRows({ count = 6, label = t("commitDetails.loading") }: { count?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex h-row items-center gap-2 px-3">
          <Skeleton className="size-3 shrink-0" />
          <Skeleton className={cn("h-3", rowWidths[index % rowWidths.length])} />
        </div>
      ))}
    </div>
  );
}

/** Placeholder for the header of a commit (summary, author, SHA). */
export function HeaderSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-3 px-3 py-3">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-5 w-5/6" />
      <Skeleton className="h-5 w-1/2" />
      <div className="flex items-center gap-2 pt-1">
        <Skeleton className="size-7 shrink-0 rounded-pill" />
        <div className="flex flex-1 flex-col gap-1.5">
          <Skeleton className="h-3 w-1/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fehler
// ---------------------------------------------------------------------------

export interface PanelErrorProps {
  title: string;
  children?: ReactNode;
  /** Message from the core, selectable. */
  detail?: string | null;
  onRetry?: () => void;
  /** Second action, e.g. “Clear selection”. */
  action?: { label: string; onClick: () => void };
}

export function PanelError({ title, children, detail, onRetry, action }: PanelErrorProps) {
  return (
    <div role="alert" className="flex flex-col items-center gap-2 px-6 py-8 text-center">
      <TriangleAlert className="size-6 text-danger" aria-hidden />
      <p className="text-md font-medium text-text">{title}</p>
      {children ? <p className="max-w-72 text-base text-text-muted">{children}</p> : null}
      {detail ? <p className="selectable max-w-72 text-sm break-words text-text-muted">{detail}</p> : null}
      {onRetry || action ? (
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          {action ? <Button onClick={action.onClick}>{action.label}</Button> : null}
          {onRetry ? (
            <Button icon={<RefreshCw className="size-icon" aria-hidden />} onClick={onRetry}>
              {t("commitDetails.retry")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Error of a query in words: message from the core plus hint. */
export function errorParts(error: unknown): { code: string; text: string; hint: string } {
  const core = toCoreError(error);
  const { text, hint } = describeError(core);
  return { code: core.code, text, hint };
}

// ---------------------------------------------------------------------------
// Kopieren
// ---------------------------------------------------------------------------

/** Writes to the clipboard; falls back to a hidden text field if the page has no focus. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // continue with the fallback
  }
  try {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    field.select();
    const ok = document.execCommand("copy");
    field.remove();
    previous?.focus();
    return ok;
  } catch {
    return false;
  }
}

/** Copy button with feedback: checkmark and announcement for two seconds. */
export function CopyButton({ text, label, copiedLabel = t("commitDetails.copied") }: { text: string; label: string; copiedLabel?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const message = state === "copied" ? copiedLabel : state === "failed" ? t("commitDetails.copyFailed") : "";
  return (
    <>
      <IconButton
        size="sm"
        label={state === "copied" ? copiedLabel : label}
        data-copied={state === "copied" ? "true" : undefined}
        icon={state === "copied" ? <Check className="size-3.5 text-success" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
        onClick={() => {
          void copyText(text).then((ok) => {
            setState(ok ? "copied" : "failed");
            if (timer.current !== null) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setState("idle"), 2000);
          });
        }}
      />
      <span role="status" className="sr-only">
        {message}
      </span>
    </>
  );
}

// ---------------------------------------------------------------------------
// SHA
// ---------------------------------------------------------------------------

/** Short SHA, selectable; the full one is in the title. */
export function ShaText({ sha, className }: { sha: Sha; className?: string }) {
  return (
    <code title={sha} className={cn("selectable font-mono text-code text-text", className)}>
      {shortSha(sha)}
    </code>
  );
}

/** Short SHA as a link to another commit (parents, base of a stash). */
export function ShaLink({ sha, label, onOpen }: { sha: Sha; label: string; onOpen: (sha: Sha) => void }) {
  return (
    <Tip label={label}>
      <button
        type="button"
        data-sha={sha}
        aria-label={`${label}: ${shortSha(sha)}`}
        onClick={() => onOpen(sha)}
        className="rounded-sm px-1 font-mono text-code text-accent hover:bg-surface-raised hover:underline"
      >
        {shortSha(sha)}
      </button>
    </Tip>
  );
}

// ---------------------------------------------------------------------------
// Date and person
// ---------------------------------------------------------------------------

const zoneFree = new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

/** Time as it was on the author's clock, with their time zone: “March 2, 2026, 08:37 (UTC+01:00)”. */
export function originalTime(iso: string, offsetMinutes: number): string {
  const shifted = new Date(new Date(iso).getTime() + offsetMinutes * 60_000);
  if (Number.isNaN(shifted.getTime())) return UNKNOWN_DATE;
  const abs = Math.abs(offsetMinutes);
  const zone = `UTC${offsetMinutes < 0 ? "−" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return `${zoneFree.format(shifted)} (${zone})`;
}

export interface DateTextProps {
  value: string;
  format: DateFormat;
  /** The author's time zone; without it the tooltip only shows the local time. */
  offsetMinutes?: number;
  className?: string;
}

/** Date according to the setting; the tooltip has the exact local time and the original time with time zone. */
export function DateText({ value, format, offsetMinutes, className }: DateTextProps) {
  const local = formatDateTime(value);
  const original = offsetMinutes === undefined ? null : originalTime(value, offsetMinutes);
  return (
    <Tip
      label={
        <span className="flex flex-col">
          <span>{t("commitDetails.date.yourTime", { time: local })}</span>
          {original ? <span>{t("commitDetails.date.authorTime", { time: original })}</span> : null}
        </span>
      }
    >
      <time dateTime={value} tabIndex={0} data-original={original ?? undefined} className={cn("rounded-sm text-text-muted", className)}>
        {formatDate(value, format)}
      </time>
    </Tip>
  );
}

export interface PersonRowProps {
  person: Person;
  /** “Author”, “Committer”, “Co-author” – shown small above the name. */
  role: string;
  size?: number;
  trailing?: ReactNode;
}

export function PersonRow({ person, role, size = 28, trailing }: PersonRowProps) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {/* Fixed column: names line up below each other, even if committer and co-authors have smaller avatars. */}
      <span className="flex w-7 shrink-0 justify-center">
        <Avatar name={person.name || person.email || "?"} email={person.email} size={size} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-baseline gap-1.5">
          <span className="sr-only">{role}: </span>
          <span className="truncate font-medium text-text" title={person.name}>
            {person.name || t("commitDetails.unknownPerson")}
          </span>
          <span aria-hidden className="shrink-0 text-xs text-text-muted">
            {role}
          </span>
        </p>
        <p className="flex min-w-0 items-center gap-1.5 text-sm text-text-muted">
          {person.email ? (
            <span className="selectable truncate" title={person.email}>
              {person.email}
            </span>
          ) : null}
          {trailing}
        </p>
      </div>
    </div>
  );
}

/** Small heading above a section of the panel. */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={cn("text-xs font-semibold tracking-wide text-text-muted uppercase", className)}>{children}</h3>;
}

/** “+12 −3” with text for screen readers. */
export function LineCounts({ added, removed }: { added: number; removed: number }) {
  if (!added && !removed) return null;
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums">
      {added ? (
        <span className="text-success">
          <span aria-hidden>+{added.toLocaleString(locale())}</span>
          <span className="sr-only">{t("commitDetails.lines.added", { count: added })}</span>
        </span>
      ) : null}
      {added && removed ? " " : null}
      {removed ? (
        <span className="text-danger">
          <span aria-hidden>−{removed.toLocaleString(locale())}</span>
          <span className="sr-only">{t("commitDetails.lines.removed", { count: removed })}</span>
        </span>
      ) : null}
    </span>
  );
}

/** Header row of the panel: kind of selection on the left, actions on the right. */
export function PanelBar({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-control-lg shrink-0 items-center gap-1 border-b border-border pr-1 pl-3">
      <SectionLabel>{title}</SectionLabel>
      {children}
    </div>
  );
}
