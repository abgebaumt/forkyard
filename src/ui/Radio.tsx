/**
 * Radio group with a sentence under each option (Radix RadioGroup): the arrow keys move and select,
 * Tab leaves the group. For choices that need an explanation each, e.g. “Normal” / “Thorough”.
 */
import { useId, type ReactNode } from "react";
import { RadioGroup } from "radix-ui";
import { cn } from "./cn";

export interface RadioOption<T extends string> {
  value: T;
  label: string;
  description?: ReactNode;
}

export interface RadioChoiceProps<T extends string> {
  /** Name of the group for screen readers. */
  label: string;
  value: T;
  options: readonly RadioOption<T>[];
  onValueChange: (value: T) => void;
  /** The selected option gets the focus when its dialog opens (`data-autofocus`). */
  autoFocus?: boolean;
}

export function RadioChoice<T extends string>({ label, value, options, onValueChange, autoFocus = false }: RadioChoiceProps<T>) {
  const base = useId();
  return (
    <RadioGroup.Root aria-label={label} value={value} onValueChange={(next) => onValueChange(next as T)} className="flex flex-col gap-2">
      {options.map((option) => {
        const id = `${base}-${option.value}`;
        return (
          <div key={option.value} data-radio={option.value} className="flex items-start gap-2">
            <RadioGroup.Item
              id={id}
              value={option.value}
              aria-describedby={option.description ? `${id}-description` : undefined}
              data-autofocus={autoFocus && option.value === value ? "" : undefined}
              className={cn(
                "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-pill border border-border-input bg-surface-sunken",
                "hover:border-text-muted data-[state=checked]:border-accent",
              )}
            >
              <RadioGroup.Indicator className="size-2 rounded-pill bg-accent" />
            </RadioGroup.Item>
            <div className="min-w-0">
              <label htmlFor={id} className="text-base text-text">
                {option.label}
              </label>
              {option.description ? (
                <div id={`${id}-description`} className="text-sm text-text-muted">
                  {option.description}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </RadioGroup.Root>
  );
}
