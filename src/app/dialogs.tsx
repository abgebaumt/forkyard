/**
 * Promise-based dialogs. Any place in the app can call `await confirm(...)`,
 * `await promptText(...)`, `await choose(...)`, `await pickFromList(...)`, `await showDialog(...)`
 * or `showOutput(...)`; they are shown by the <DialogHost /> in the shell
 * (one after the other).
 */
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Search } from "lucide-react";
import { Button } from "../ui/Button";
import { ConfirmDialog, Dialog } from "../ui/Dialog";
import { TextField } from "../ui/Field";
import { cn } from "../ui/cn";
import { locale, t } from "../i18n";

export interface ConfirmOptions {
  /** As a question naming the concrete subject, e.g. "Delete branch 'feature/x'?" */
  title: string;
  /** What is lost and whether it can be recovered. */
  body: ReactNode;
  /** The verb, never "OK", e.g. "Delete branch". */
  confirmLabel: string;
  danger?: boolean;
  /** What is affected, as a list (files, commits). Long lists are truncated. */
  details?: string[];
  /** Heading of the list, e.g. "These changes will be lost". */
  detailsLabel?: string;
}

export interface PromptOptions {
  title: string;
  label: string;
  description?: ReactNode;
  initial?: string;
  placeholder?: string;
  /** Monospace for branch names, URLs, paths. */
  mono?: boolean;
  /** Error text or null. May be async (e.g. refNameCheck in the core). */
  validate?: (value: string) => string | null | Promise<string | null>;
  /** Applied while typing, e.g. space → "-" for branch names. */
  normalize?: (value: string) => string;
  confirmLabel: string;
}

export interface ChoiceOption<K extends string = string> {
  key: K;
  label: string;
  description?: string;
  danger?: boolean;
}

export interface ChooseOptions<K extends string = string> {
  title: string;
  description?: ReactNode;
  options: ChoiceOption<K>[];
  /** What is affected, as a list (e.g. the files blocking a checkout). */
  details?: string[];
  detailsLabel?: string;
}

export interface PickItem<K extends string = string> {
  key: K;
  label: string;
  /** Second, muted detail on the right (e.g. "current upstream"). */
  description?: string;
}

export interface PickOptions<K extends string = string> {
  title: string;
  description?: ReactNode;
  /** Label of the filter field, e.g. "Remote branch". */
  label: string;
  items: PickItem<K>[];
  /** Preselection. */
  initial?: K;
  /** Text when there is nothing to choose from. */
  empty?: string;
  confirmLabel: string;
  mono?: boolean;
}

/** Content of a custom dialog. `done(value)` closes it; `done(null)` means cancelled. */
export type CustomDialogRender<T> = (done: (value: T | null) => void) => ReactNode;

type Request =
  | { id: number; type: "confirm"; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { id: number; type: "prompt"; options: PromptOptions; resolve: (value: string | null) => void }
  | { id: number; type: "choose"; options: ChooseOptions; resolve: (value: string | null) => void }
  | { id: number; type: "pick"; options: PickOptions; resolve: (value: string | null) => void }
  | { id: number; type: "custom"; render: CustomDialogRender<unknown>; resolve: (value: unknown) => void }
  | { id: number; type: "output"; options: { title: string; text: string }; resolve: (value: null) => void };

let queue: Request[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

function push<T>(build: (id: number, resolve: (value: T) => void) => Request): Promise<T> {
  return new Promise<T>((resolve) => {
    queue = [...queue, build(nextId++, resolve)];
    emit();
  });
}

function finish(id: number) {
  queue = queue.filter((item) => item.id !== id);
  emit();
}

export function confirm(options: ConfirmOptions): Promise<boolean> {
  return push<boolean>((id, resolve) => ({ id, type: "confirm", options, resolve }));
}

export function promptText(options: PromptOptions): Promise<string | null> {
  return push<string | null>((id, resolve) => ({ id, type: "prompt", options, resolve }));
}

export function choose<K extends string>(options: ChooseOptions<K>): Promise<K | null> {
  return push<string | null>((id, resolve) => ({ id, type: "choose", options: options as ChooseOptions, resolve })) as Promise<K | null>;
}

/** Pick an entry from a filterable list (remote branch as upstream, branch to merge …). */
export function pickFromList<K extends string>(options: PickOptions<K>): Promise<K | null> {
  return push<string | null>((id, resolve) => ({ id, type: "pick", options: options as PickOptions, resolve })) as Promise<K | null>;
}

/**
 * Custom dialog with arbitrary content (forms with several fields). `render` receives `done` and
 * returns a `<Dialog open …>`; like the other dialogs it appears on its own and in order.
 */
export function showDialog<T>(render: CustomDialogRender<T>): Promise<T | null> {
  return push<unknown>((id, resolve) => ({ id, type: "custom", render: render as CustomDialogRender<unknown>, resolve })) as Promise<T | null>;
}

/** Shows longer text (e.g. Git output) selectable in a dialog. */
export function showOutput(title: string, text: string): Promise<null> {
  return push<null>((id, resolve) => ({ id, type: "output", options: { title, text }, resolve }));
}

/** Whether a dialog from this module is currently open. */
export function hasOpenDialog(): boolean {
  return queue.length > 0;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Mount once in the shell. */
export function DialogHost() {
  const items = useSyncExternalStore(subscribe, () => queue);
  const current = items[0];
  if (!current) return null;

  switch (current.type) {
    case "confirm":
      return (
        <ConfirmDialog
          key={current.id}
          open
          title={current.options.title}
          description={
            current.options.details?.length ? (
              <>
                {current.options.body}
                <DetailList items={current.options.details} label={current.options.detailsLabel} />
              </>
            ) : (
              current.options.body
            )
          }
          confirmLabel={current.options.confirmLabel}
          danger={current.options.danger}
          onOpenChange={(open) => {
            if (!open) {
              current.resolve(false);
              finish(current.id);
            }
          }}
          onConfirm={() => {
            current.resolve(true);
            finish(current.id);
          }}
        />
      );
    case "prompt":
      return (
        <PromptDialog
          key={current.id}
          options={current.options}
          onDone={(value) => {
            current.resolve(value);
            finish(current.id);
          }}
        />
      );
    case "choose":
      return (
        <ChooseDialog
          key={current.id}
          options={current.options}
          onDone={(value) => {
            current.resolve(value);
            finish(current.id);
          }}
        />
      );
    case "pick":
      return (
        <PickDialog
          key={current.id}
          options={current.options}
          onDone={(value) => {
            current.resolve(value);
            finish(current.id);
          }}
        />
      );
    case "custom":
      return (
        <CustomDialog
          key={current.id}
          render={current.render}
          onDone={(value) => {
            current.resolve(value);
            finish(current.id);
          }}
        />
      );
    case "output":
      return (
        <Dialog
          key={current.id}
          open
          size="lg"
          title={current.options.title}
          onOpenChange={(open) => {
            if (!open) {
              current.resolve(null);
              finish(current.id);
            }
          }}
          footer={
            <>
              <Button
                onClick={() => {
                  void navigator.clipboard?.writeText(current.options.text).catch(() => undefined);
                }}
              >
                {t("app.dialogs.copy")}
              </Button>
              <Button
                variant="primary"
                autoFocus
                data-autofocus
                onClick={() => {
                  current.resolve(null);
                  finish(current.id);
                }}
              >
                {t("app.dialogs.close")}
              </Button>
            </>
          }
        >
          <pre className="selectable max-h-96 overflow-auto rounded-md bg-surface-sunken p-3 font-mono text-code whitespace-pre-wrap text-text">
            {current.options.text || t("app.dialogs.noOutput")}
          </pre>
        </Dialog>
      );
  }
}

const DETAIL_LIMIT = 8;

/** Compact list of affected items in a prompt; truncated from nine entries on. Long lines get a tooltip. */
export function DetailList({ items, label, className }: { items: string[]; label?: string; className?: string }) {
  const shown = items.slice(0, DETAIL_LIMIT);
  const rest = items.length - shown.length;
  // span instead of div/ul: the list also appears in a dialog's description, and that is a paragraph.
  return (
    <span className={cn("mt-3 block", className)}>
      {label ? <span className="mb-1 block text-sm font-medium text-text">{label}</span> : null}
      <span role="list" className="selectable block rounded-md border border-border bg-surface-sunken px-2 py-1 font-mono text-code text-text">
        {shown.map((item, index) => (
          <span role="listitem" key={index} className="block truncate" title={item}>
            {item}
          </span>
        ))}
        {rest > 0 ? (
          <span role="listitem" className="block font-sans text-sm text-text-muted">
            {t("app.dialogs.andMore", { count: rest, formatted: rest.toLocaleString(locale()) })}
          </span>
        ) : null}
      </span>
    </span>
  );
}

function CustomDialog({ render, onDone }: { render: CustomDialogRender<unknown>; onDone: (value: unknown) => void }) {
  return <>{render(onDone)}</>;
}

function PromptDialog({ options, onDone }: { options: PromptOptions; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(options.initial ?? "");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const checkId = useRef(0);

  // Validate while typing (slightly debounced, so the core is not asked on every keystroke).
  useEffect(() => {
    const validate = options.validate;
    if (!validate) return;
    const id = ++checkId.current;
    if (!value.trim()) {
      setError(null);
      setChecking(false);
      return;
    }
    setChecking(true);
    const timer = window.setTimeout(async () => {
      let result: string | null;
      try {
        result = await validate(value.trim());
      } catch {
        result = null;
      }
      if (id === checkId.current) {
        setError(result);
        setChecking(false);
      }
    }, 150);
    return () => window.clearTimeout(timer);
  }, [value, options]);

  const submit = async () => {
    if (!value.trim() || submitting) return;
    if (options.validate) {
      setSubmitting(true);
      let result: string | null;
      try {
        result = await options.validate(value.trim());
      } catch {
        result = null;
      }
      setSubmitting(false);
      if (result) {
        setError(result);
        return;
      }
    } else if (error) {
      return;
    }
    onDone(value.trim());
  };

  // During validation the button stays enabled; submit() validates again anyway.
  const blocked = !value.trim() || (Boolean(error) && !checking);

  return (
    <Dialog
      open
      size="sm"
      title={options.title}
      description={options.description}
      onOpenChange={(open) => {
        if (!open) onDone(null);
      }}
      footer={
        <>
          <Button onClick={() => onDone(null)}>{t("app.common.cancel")}</Button>
          <Button variant="primary" disabled={blocked && !submitting} loading={submitting} onClick={() => void submit()}>
            {options.confirmLabel}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <TextField
          autoFocus
          data-autofocus
          onFocus={(event) => event.currentTarget.select()}
          label={options.label}
          value={value}
          placeholder={options.placeholder}
          mono={options.mono}
          error={error ?? undefined}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          onChange={(event) => setValue(options.normalize ? options.normalize(event.target.value) : event.target.value)}
        />
      </form>
    </Dialog>
  );
}

function ChooseDialog({ options, onDone }: { options: ChooseOptions; onDone: (value: string | null) => void }) {
  const listRef = useRef<HTMLDivElement>(null);

  const move = (delta: number) => {
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const index = buttons.findIndex((button) => button === document.activeElement);
    const next = buttons[(index + delta + buttons.length) % buttons.length];
    next?.focus();
  };

  // Focus is on the first non-dangerous option; if all are dangerous, on "Cancel".
  const safeIndex = options.options.findIndex((option) => !option.danger);

  return (
    <Dialog
      open
      size="sm"
      title={options.title}
      description={options.description}
      onOpenChange={(open) => {
        if (!open) onDone(null);
      }}
      footer={
        <Button autoFocus={safeIndex < 0} data-autofocus={safeIndex < 0 || undefined} onClick={() => onDone(null)}>
          {t("app.common.cancel")}
        </Button>
      }
    >
      {options.details?.length ? <DetailList items={options.details} label={options.detailsLabel} className="mt-0 mb-3" /> : null}
      <div
        ref={listRef}
        role="group"
        aria-label={options.title}
        className="flex flex-col gap-1"
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            move(1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            move(-1);
          }
        }}
      >
        {options.options.map((option, index) => (
          <button
            key={option.key}
            type="button"
            autoFocus={index === safeIndex}
            data-autofocus={index === safeIndex || undefined}
            onClick={() => onDone(option.key)}
            className={cn(
              "flex flex-col items-start rounded-md border border-border px-3 py-2 text-left hover:bg-surface-raised",
              option.danger ? "text-danger" : "text-text",
            )}
          >
            <span className="text-base font-medium">{option.label}</span>
            {option.description ? <span className="text-sm text-text-muted">{option.description}</span> : null}
          </button>
        ))}
      </div>
    </Dialog>
  );
}

/** The pick list renders no more rows than this at once; beyond that, the filter narrows it down. */
const PICK_RENDER_LIMIT = 200;

function PickDialog({ options, onDone }: { options: PickOptions; onDone: (value: string | null) => void }) {
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState<string | null>(options.initial ?? options.items[0]?.key ?? null);
  const listId = useId();

  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? options.items.filter((item) => `${item.label} ${item.description ?? ""}`.toLowerCase().includes(needle)) : options.items;
  }, [filter, options.items]);
  const shown = matches.slice(0, PICK_RENDER_LIMIT);
  const current = shown.find((item) => item.key === active) ?? shown[0] ?? null;
  const currentIndex = current ? shown.indexOf(current) : -1;
  const optionId = (index: number) => `${listId}-option-${index}`;

  useEffect(() => {
    if (currentIndex >= 0) document.getElementById(`${listId}-option-${currentIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [currentIndex, listId]);

  const move = (delta: number) => {
    const next = shown[Math.max(0, Math.min(shown.length - 1, currentIndex + delta))];
    if (next) setActive(next.key);
  };

  return (
    <Dialog
      open
      size="sm"
      title={options.title}
      description={options.description}
      onOpenChange={(open) => {
        if (!open) onDone(null);
      }}
      footer={
        <>
          <Button onClick={() => onDone(null)}>{t("app.common.cancel")}</Button>
          <Button variant="primary" disabled={!current} onClick={() => current && onDone(current.key)}>
            {options.confirmLabel}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (current) onDone(current.key);
        }}
      >
        <div className="relative">
          <TextField
            autoFocus
            data-autofocus
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={currentIndex >= 0 ? optionId(currentIndex) : undefined}
            label={options.label}
            value={filter}
            placeholder={t("app.dialogs.filter")}
            autoComplete="off"
            className="pl-7"
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                move(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                move(-1);
              } else if (event.key === "PageDown") {
                event.preventDefault();
                move(8);
              } else if (event.key === "PageUp") {
                event.preventDefault();
                move(-8);
              }
            }}
          />
          <Search className="pointer-events-none absolute bottom-1.5 left-2 size-icon text-text-muted" aria-hidden />
        </div>
        <div id={listId} role="listbox" aria-label={options.label} className="max-h-64 overflow-auto rounded-md border border-border bg-surface-sunken p-1">
          {shown.length === 0 ? (
            <p className="px-2 py-1 text-sm text-text-muted">
              {options.items.length === 0 ? (options.empty ?? t("app.dialogs.nothingToChoose")) : t("app.dialogs.noMatch", { filter: filter.trim() })}
            </p>
          ) : (
            shown.map((item, index) => {
              const selected = index === currentIndex;
              return (
                <div
                  key={item.key}
                  id={optionId(index)}
                  role="option"
                  aria-selected={selected}
                  title={item.description ? `${item.label} – ${item.description}` : item.label}
                  // Focus stays in the filter field (combobox pattern).
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setActive(item.key)}
                  onDoubleClick={() => onDone(item.key)}
                  className={cn("flex h-row items-center gap-2 rounded-sm px-2 text-text", selected ? "bg-accent-surface" : "hover:bg-surface-raised")}
                >
                  <span className={cn("min-w-0 flex-1 truncate", options.mono && "font-mono text-code")}>{item.label}</span>
                  {item.description ? <span className="max-w-40 shrink-0 truncate text-sm text-text-muted">{item.description}</span> : null}
                </div>
              );
            })
          )}
          {matches.length > shown.length ? (
            <p className="px-2 py-1 text-sm text-text-muted">{t("app.dialogs.pickMore", { count: matches.length - shown.length })}</p>
          ) : null}
        </div>
      </form>
    </Dialog>
  );
}
