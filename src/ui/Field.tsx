import { useId, useRef, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type TextareaHTMLAttributes } from "react";
import { Check, Minus } from "lucide-react";
import { Checkbox as RadixCheckbox, ToggleGroup } from "radix-ui";
import { cn } from "./cn";

const control =
  "w-full rounded-md border border-border-input bg-surface-sunken px-2 text-base text-text " +
  "placeholder:text-text-muted hover:border-text-muted " +
  "focus-visible:border-accent focus-visible:outline-accent " +
  "disabled:border-border disabled:text-text-disabled disabled:placeholder:text-text-disabled " +
  "aria-invalid:border-danger aria-invalid:focus-visible:outline-danger";

interface FieldShellProps {
  id: string;
  label?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}

function FieldShell({ id, label, hint, error, children }: FieldShellProps) {
  return (
    <div className="flex flex-col gap-1">
      {label ? (
        <label htmlFor={id} className="text-sm font-medium text-text-muted">
          {label}
        </label>
      ) : null}
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-sm text-text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  mono?: boolean;
}

export function TextField({ label, hint, error, mono, className, id, ...rest }: TextFieldProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldShell id={fieldId} label={label} hint={hint} error={error}>
      <input
        id={fieldId}
        className={cn(control, "h-control-md", mono && "font-mono text-code", className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined}
        spellCheck={false}
        {...rest}
      />
    </FieldShell>
  );
}

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export function TextArea({ label, hint, error, className, id, rows = 4, ...rest }: TextAreaProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldShell id={fieldId} label={label} hint={hint} error={error}>
      <textarea
        id={fieldId}
        rows={rows}
        className={cn(control, "resize-y py-1.5", className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined}
        {...rest}
      />
    </FieldShell>
  );
}

export interface CheckboxProps {
  label: ReactNode;
  checked: boolean | "indeterminate";
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  hint?: string;
}

export function Checkbox({ label, checked, onCheckedChange, disabled, hint }: CheckboxProps) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <RadixCheckbox.Root
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onCheckedChange?.(value === true)}
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm border border-border-input bg-surface-sunken",
          "hover:border-text-muted data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-on-accent",
          "data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent data-[state=indeterminate]:text-on-accent",
          "disabled:border-border disabled:bg-surface disabled:text-text-disabled",
        )}
      >
        <RadixCheckbox.Indicator>
          {checked === "indeterminate" ? (
            <Minus className="size-3" strokeWidth={3} aria-hidden />
          ) : (
            <Check className="size-3" strokeWidth={3} aria-hidden />
          )}
        </RadixCheckbox.Indicator>
      </RadixCheckbox.Root>
      <label htmlFor={id} className={cn("text-base", disabled ? "text-text-disabled" : "text-text")}>
        {label}
        {hint ? <span className="block text-sm text-text-muted">{hint}</span> : null}
      </label>
    </div>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

export interface SegmentedControlProps<T extends string> {
  /** Describes the group for screen readers, e.g. "Diff view". */
  label: string;
  value: T;
  options: SegmentedOption<T>[];
  onValueChange: (value: T) => void;
  /** Shows only the icons; the labels stay for screen readers and as tooltip. */
  iconOnly?: boolean;
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onValueChange,
  iconOnly = false,
}: SegmentedControlProps<T>) {
  const rootRef = useRef<HTMLDivElement>(null);
  /** The entry last chosen by key – focus should land there even when keys are pressed in quick succession. */
  const wanted = useRef<string | null>(null);
  /**
   * Arrow keys select directly (not just focus as in Radix' ToggleGroup): ←/↑ previous,
   * →/↓ next entry (wrapping), Home/End first/last. Focus follows the selection.
   */
  const onItemKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    // Computed from the focused entry: some callers only save the choice first (settings), and
    // `value` follows a moment later – but focus is already on the new entry.
    const from = event.currentTarget.dataset.value ?? value;
    const known = options.findIndex((option) => option.value === from);
    const index = known >= 0 ? known : options.findIndex((option) => option.value === value);
    let next = -1;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % options.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + options.length) % options.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = options.length - 1;
    else return;
    // preventDefault also holds back Radix' own arrow navigation (focus only).
    event.preventDefault();
    const target = options[next];
    if (!target) return;
    if (target.value !== value) onValueChange(target.value);
    const root = rootRef.current;
    wanted.current = target.value;
    const focusSelected = () => {
      // Some callers re-render on change; then the group no longer exists (they set focus themselves).
      if (root?.isConnected && wanted.current !== null) root.querySelector<HTMLElement>(`[data-value="${CSS.escape(wanted.current)}"]`)?.focus();
    };
    focusSelected();
    // Once more a frame later – for callers that re-render on change and lose focus in the
    // process. But only then: if focus has meanwhile arrived somewhere else (Tab into the next field –
    // a frame can take a long time in a hidden window), it is not pulled back.
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body || root?.contains(active)) focusSelected();
    });
  };
  return (
    <ToggleGroup.Root
      ref={rootRef}
      type="single"
      aria-label={label}
      value={value}
      // A selection always remains: clicking again does not deselect.
      onValueChange={(next) => {
        if (next) onValueChange(next as T);
      }}
      className="inline-flex h-control-sm items-center rounded-md border border-border bg-surface-sunken p-0.5"
    >
      {options.map((option) => (
        <ToggleGroup.Item
          key={option.value}
          value={option.value}
          data-value={option.value}
          onKeyDown={onItemKeyDown}
          title={iconOnly ? option.label : undefined}
          className={cn(
            "inline-flex h-full items-center gap-1 rounded-sm px-2 text-sm font-medium whitespace-nowrap text-text-muted",
            "hover:text-text data-[state=on]:bg-surface-raised data-[state=on]:text-text",
          )}
        >
          {option.icon}
          {iconOnly ? <span className="sr-only">{option.label}</span> : option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
