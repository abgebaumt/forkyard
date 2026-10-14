import { useId } from "react";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { Select as RadixSelect } from "radix-ui";
import { cn } from "./cn";
import { menuSurface } from "./Menu";
import { collisionPadding } from "../app/zoom";

export interface SelectOption<T extends string = string> {
  /** Must not be empty (Radix); for "none" use a separate value such as "none". */
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string = string> {
  /** Visible label above the field. If it is missing, `ariaLabel` is required. */
  label?: string;
  ariaLabel?: string;
  hint?: string;
  error?: string;
  value: T;
  options: SelectOption<T>[];
  onValueChange: (value: T) => void;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  className?: string;
  /** Short muted text inside the field before the value ("Branch main"), for toolbars without a label above. */
  prefix?: string;
}

/**
 * Select list (Radix Select): arrow keys and initial letters select, Enter or Space
 * opens, Esc closes. Looks like a text field, the list like a menu.
 */
export function Select<T extends string = string>({
  label,
  ariaLabel,
  hint,
  error,
  value,
  options,
  onValueChange,
  disabled,
  placeholder,
  id,
  className,
  prefix,
}: SelectProps<T>) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {label ? (
        <label htmlFor={fieldId} className="text-sm font-medium text-text-muted">
          {label}
        </label>
      ) : null}
      <RadixSelect.Root value={value} onValueChange={(next) => onValueChange(next as T)} disabled={disabled}>
        <RadixSelect.Trigger
          id={fieldId}
          aria-label={label ? undefined : ariaLabel}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined}
          className={cn(
            "flex h-control-md w-full min-w-0 items-center justify-between gap-2 rounded-md border border-border-input bg-surface-sunken px-2 text-left text-base text-text",
            "hover:border-text-muted focus-visible:border-accent data-[placeholder]:text-text-muted",
            "disabled:border-border disabled:text-text-disabled aria-invalid:border-danger",
            className,
          )}
        >
          {prefix ? (
            <span className="shrink-0 text-text-muted" aria-hidden>
              {prefix}
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate">
            <RadixSelect.Value placeholder={placeholder} />
          </span>
          <RadixSelect.Icon className="shrink-0 text-text-muted">
            <ChevronDown className="size-icon" aria-hidden />
          </RadixSelect.Icon>
        </RadixSelect.Trigger>
        <RadixSelect.Portal>
          <RadixSelect.Content
            position="popper"
            sideOffset={4}
            collisionPadding={collisionPadding()}
            className={cn(menuSurface, "max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) overflow-hidden")}
          >
            <RadixSelect.ScrollUpButton className="flex h-5 items-center justify-center text-text-muted">
              <ChevronUp className="size-icon" aria-hidden />
            </RadixSelect.ScrollUpButton>
            <RadixSelect.Viewport>
              {options.map((option) => (
                <RadixSelect.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className={cn(
                    "flex h-row cursor-default items-center gap-2 rounded-sm px-2 outline-none",
                    "data-[highlighted]:bg-accent-surface data-[disabled]:text-text-disabled",
                  )}
                >
                  <span className="flex size-icon shrink-0 items-center justify-center" aria-hidden>
                    <RadixSelect.ItemIndicator>
                      <Check className="size-icon" />
                    </RadixSelect.ItemIndicator>
                  </span>
                  <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                </RadixSelect.Item>
              ))}
            </RadixSelect.Viewport>
            <RadixSelect.ScrollDownButton className="flex h-5 items-center justify-center text-text-muted">
              <ChevronDown className="size-icon" aria-hidden />
            </RadixSelect.ScrollDownButton>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
      {error ? (
        <p id={`${fieldId}-error`} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${fieldId}-hint`} className="text-sm text-text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
