/**
 * Building blocks of the settings form: section, row (name, one sentence of explanation, field),
 * text field with immediate saving, badges, skeleton and error box.
 */
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "../../ui/Button";
import { TextField } from "../../ui/Field";
import { cn } from "../../ui/cn";
import { describeError } from "../../app/errors";
import { t } from "../../i18n";

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

/** The settings search text; matching rows are highlighted. */
export const SettingsSearch = createContext("");

/** A section's level above its heading: "Global · in all profiles" etc. */
export function ScopePill({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <p data-scope className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-0.5 text-sm font-medium text-text-muted">
      {icon}
      {children}
    </p>
  );
}

/** Named group of rows in a box. */
export function SettingsCard({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="mt-5 first-of-type:mt-3">
      <h3 id={id} className="mb-1.5 pl-0.5 text-xs font-semibold tracking-wide text-text-muted uppercase">
        {title}
      </h3>
      <div className="rounded-lg border border-border bg-surface px-4">{children}</div>
    </section>
  );
}

export function SectionHeader({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-2 flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <h2 className="text-lg font-semibold text-text">{title}</h2>
        {children ? <p className="mt-1 text-base text-text-muted">{children}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
    </header>
  );
}

/** Subheading within a section. */
export function GroupTitle({ children, id, flush }: { children: ReactNode; id?: string; flush?: boolean }) {
  return (
    <h3 id={id} className={cn("mb-1 text-xs font-semibold tracking-wide text-text-muted uppercase", !flush && "mt-6")}>
      {children}
    </h3>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

export interface FieldIds {
  /** Goes on the control. */
  id: string;
  labelId: string;
  descriptionId: string;
}

export interface SettingRowProps {
  title: string;
  /** One sentence: what the setting does. */
  description: ReactNode;
  /** Field below the text instead of to the right (for long inputs). */
  stacked?: boolean;
  /** The field is a group (toggles): the name is then not a <label>, the group carries it itself. */
  group?: boolean;
  /** If the value deviates from the default: "Changed" and a button that resets it. */
  changed?: { onReset: () => void };
  children: (ids: FieldIds) => ReactNode;
}

export function SettingRow({ title, description, stacked, group, changed, children }: SettingRowProps) {
  const query = useContext(SettingsSearch).trim().toLowerCase();
  const match = query !== "" && title.toLowerCase().includes(query);
  const base = useId();
  const ids: FieldIds = { id: `${base}-field`, labelId: `${base}-label`, descriptionId: `${base}-description` };
  const name = group ? (
    <p id={ids.labelId} className="text-base font-medium text-text">
      {title}
    </p>
  ) : (
    <label id={ids.labelId} htmlFor={ids.id} className="text-base font-medium text-text">
      {title}
    </label>
  );
  return (
    <div
      data-setting={title}
      data-match={match || undefined}
      className={cn("border-b border-border py-3 last:border-b-0", match && "-mx-4 bg-accent-surface px-4", stacked ? "flex flex-col gap-2" : "flex items-start gap-6")}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          {name}
          {changed ? (
            <span className="text-xs font-medium text-accent">
              {t("preferences.row.changed")} ·{" "}
              <button type="button" className="text-text-muted underline underline-offset-2 hover:text-text" onClick={changed.onReset}>
                {t("preferences.row.reset")}
              </button>
            </span>
          ) : null}
        </div>
        <p id={ids.descriptionId} className="text-sm text-text-muted">
          {description}
        </p>
      </div>
      <div className={cn("min-w-0", stacked ? "w-full" : "flex shrink-0 items-center justify-end pt-0.5")}>{children(ids)}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Text field that saves on blur or with Enter
// ---------------------------------------------------------------------------

export interface CommitTextProps {
  id: string;
  describedBy?: string;
  value: string;
  /** Saves. Returns an error text for the field, or null. */
  onCommit: (value: string) => Promise<string | null>;
  /** Check before saving; error text or null. */
  validate?: (value: string) => string | null;
  mono?: boolean;
  placeholder?: string;
  type?: "text" | "email";
  className?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}

/**
 * Text applies as soon as the field is left or Enter is pressed – there is no save button.
 * A check mark on the right of the field confirms the save; an error appears right below and the typed text stays.
 */
export function CommitText({ id, describedBy, value, onCommit, validate, mono, placeholder, type = "text", className, disabled, autoFocus }: CommitTextProps) {
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const focused = useRef(false);
  const lastSent = useRef<string | null>(null);

  // Take over the value from outside as long as nobody is typing.
  useEffect(() => {
    if (!focused.current) {
      setText(value);
      setError(null);
    }
  }, [value]);

  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 2000);
    return () => window.clearTimeout(timer);
  }, [saved]);

  const commit = async () => {
    const next = text.trim();
    if (next === value.trim()) {
      if (next !== text) setText(next);
      setError(null);
      return;
    }
    const problem = validate?.(next) ?? null;
    if (problem) {
      setError(problem);
      return;
    }
    // Enter and the subsequent blur of the field save only once.
    if (lastSent.current === next) return;
    lastSent.current = next;
    const failure = await onCommit(next);
    lastSent.current = null;
    setError(failure);
    if (!failure) setSaved(true);
  };

  return (
    <div className={cn("relative", className)}>
      <TextField
        id={id}
        type={type}
        value={text}
        mono={mono}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        error={error ?? undefined}
        {...(error || !describedBy ? {} : { "aria-describedby": describedBy })}
        onChange={(event) => {
          setText(event.target.value);
          if (error) setError(null);
        }}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          void commit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commit();
          }
        }}
      />
      {saved ? (
        <span role="status" className="pointer-events-none absolute top-1.5 right-2 flex items-center text-success">
          <Check className="size-icon" aria-hidden />
          <span className="sr-only">{t("preferences.row.saved")}</span>
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Badges, skeleton, error
// ---------------------------------------------------------------------------

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

const badgeTone: Record<BadgeTone, string> = {
  neutral: "border-border bg-surface-raised text-text-muted",
  accent: "border-transparent bg-accent-surface text-text",
  success: "border-transparent bg-success-surface text-text",
  warning: "border-transparent bg-warning-surface text-text",
  danger: "border-transparent bg-danger-surface text-text",
};

const badgeIcon: Record<BadgeTone, string> = {
  neutral: "text-text-muted",
  accent: "text-accent",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

/** Small badge with text – the state is always written as a word, icon and colour come on top. */
export function Badge({ tone = "neutral", icon, children, title }: { tone?: BadgeTone; icon?: ReactNode; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border px-1.5 text-xs font-medium whitespace-nowrap", badgeTone[tone])}>
      {icon ? <span className={cn("flex", badgeIcon[tone])}>{icon}</span> : null}
      {children}
    </span>
  );
}

/** Placeholder rows while a section loads. */
export function SettingsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div role="status" aria-label={t("preferences.row.loading")} className="animate-pulse">
      <div className="mb-4 h-6 w-48 rounded-sm bg-surface-raised" />
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-start gap-6 border-b border-border py-3 last:border-b-0">
          <div className="flex-1">
            <div className="h-4 w-40 rounded-sm bg-surface-raised" />
            <div className="mt-2 h-3 w-80 max-w-full rounded-sm bg-surface-raised" />
          </div>
          <div className="h-5 w-16 rounded-sm bg-surface-raised" />
        </div>
      ))}
    </div>
  );
}

/** A section could not be loaded: reason and "Try again". `title` is the whole sentence ("… could not be loaded"). */
export function LoadError({ title, error, onRetry }: { title: string; error: unknown; onRetry: () => void }) {
  const { text, hint } = describeError(error);
  return (
    <div role="alert" className="flex items-start gap-3 rounded-md border border-border bg-danger-surface p-3">
      <TriangleAlert className="mt-0.5 size-icon shrink-0 text-danger" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-text">{title}</p>
        <p className="selectable text-sm break-words text-text-muted">{hint ? `${text} ${hint}` : text}</p>
      </div>
      <Button size="sm" icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={onRetry}>
        {t("preferences.row.retry")}
      </Button>
    </div>
  );
}

/** Value to read and select, e.g. a path or fingerprint. Truncates and shows the full text in the tooltip. */
export function Mono({ children, className, wrap }: { children: string; className?: string; wrap?: boolean }) {
  return (
    <span title={wrap ? undefined : children} className={cn("selectable font-mono text-code text-text", wrap ? "break-all" : "block truncate", className)}>
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Project row with inheritance
// ---------------------------------------------------------------------------

export interface InheritRowProps {
  title: string;
  description: ReactNode;
  /** Does an own project value apply? */
  own: boolean;
  /** Where the inherited value comes from, e.g. the profile's name or "Git". */
  source: string;
  /** The inherited value as it is displayed. */
  inherited: string;
  onOverride: () => void;
  /** Reason why there is nothing to override; the button is then disabled. */
  overrideDisabled?: string;
  onReset: () => void;
  stacked?: boolean;
  /** The control for the own value. */
  children: (ids: FieldIds) => ReactNode;
}

/** Without an own value: "From <source>: <value>" and "Override". With an own value: marked, with "Reset". */
export function InheritRow({ title, description, own: stored, source, inherited, onOverride, overrideDisabled, onReset, stacked, children }: InheritRowProps) {
  const base = useId();
  const ids: FieldIds = { id: `${base}-field`, labelId: `${base}-label`, descriptionId: `${base}-description` };
  const query = useContext(SettingsSearch).trim().toLowerCase();
  const match = query !== "" && title.toLowerCase().includes(query);
  // After "Override" the field stays open even if the adopted value was empty
  // (then there is no own value yet, but something to type in).
  const [editing, setEditing] = useState(false);
  const own = stored || editing;
  const rowRef = useRef<HTMLDivElement>(null);
  const focusNext = useRef<"field" | "override" | null>(null);
  useEffect(() => {
    // The pressed button disappears on toggling; focus goes to its counterpart instead of the dialog's start.
    const target = focusNext.current;
    if (!target) return;
    const row = rowRef.current;
    const element = row?.querySelector<HTMLElement>(target === "field" ? `[id="${ids.id}"]` : "[data-override]");
    if (element) {
      element.focus();
      focusNext.current = null;
    }
  });
  return (
    <div
      ref={rowRef}
      data-setting={title}
      data-own={own || undefined}
      data-match={match || undefined}
      className={cn(
        "-mx-4 border-b border-border px-4 py-3 last:border-b-0",
        own && "relative before:absolute before:inset-y-0 before:left-0 before:w-0.75 before:bg-warning",
        match && "bg-accent-surface",
        stacked && own ? "flex flex-col gap-2" : "flex items-start gap-6",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <label id={ids.labelId} htmlFor={own ? ids.id : undefined} className="text-base font-medium text-text">
            {title}
          </label>
          {own ? (
            <span className="text-xs font-medium text-warning">
              {t("preferences.inherit.own")} ·{" "}
              <button
                type="button"
                className="text-text-muted underline underline-offset-2 hover:text-text"
                onClick={() => {
                  setEditing(false);
                  focusNext.current = "override";
                  onReset();
                }}
              >
                {t("preferences.inherit.resetTo", { source })}
              </button>
            </span>
          ) : null}
        </div>
        <p id={ids.descriptionId} className="text-sm text-text-muted">
          {description}
        </p>
      </div>
      <div className={cn("min-w-0", stacked && own ? "w-full" : "flex shrink-0 items-center justify-end gap-3 pt-0.5")}>
        {own ? (
          children(ids)
        ) : (
          <>
            <span className="max-w-64 truncate text-sm text-text-muted" title={inherited}>
              {t("preferences.inherit.from", { source })} <span className="font-mono text-code text-text">{inherited}</span>
            </span>
            <Button
              size="md"
              data-override
              aria-describedby={ids.descriptionId}
              aria-label={t("preferences.inherit.overrideLabel", { title })}
              aria-disabled={overrideDisabled ? true : undefined}
              title={overrideDisabled}
              onClick={() => {
                if (overrideDisabled) return;
                setEditing(true);
                focusNext.current = "field";
                onOverride();
              }}
            >
              {t("preferences.inherit.override")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
