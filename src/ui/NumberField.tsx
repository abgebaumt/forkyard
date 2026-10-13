import { useEffect, useId, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { cn } from "./cn";
import { t } from "../i18n";

export interface NumberFieldProps {
  value: number;
  /** Only called with valid values clamped to the bounds – on blur, on Enter and on the step keys. */
  onCommit: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  /** Step for Page Up/Page Down; defaults to ten times `step`. */
  largeStep?: number;
  /** Unit after the number, e.g. "min" or "%". */
  unit?: string;
  label?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
  hint?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}

const stepButton =
  "inline-flex h-full w-6 shrink-0 items-center justify-center text-text-muted hover:bg-surface-raised hover:text-text " +
  "disabled:pointer-events-none disabled:text-text-disabled";

/**
 * Number field with bounds. Typing is free; the value is applied on blur or with Enter, then
 * clamped to `min`…`max` and rounded to the step. Arrow up/down, Page Up/Down, Home/End and
 * the two buttons change it immediately. Invalid input jumps back to the last value on blur.
 */
export function NumberField({
  value,
  onCommit,
  min,
  max,
  step = 1,
  largeStep,
  unit,
  label,
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
  hint,
  disabled,
  id,
  className,
}: NumberFieldProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const [text, setText] = useState(String(value));
  const [range, setRange] = useState<string | null>(null);

  // Take over a value from outside (response of the core, reset).
  useEffect(() => {
    setText(String(value));
  }, [value]);

  const clamp = (raw: number) => {
    const snapped = Math.round(raw / step) * step;
    // Remove rounding residue from floating-point arithmetic (0.30000000000000004).
    const clean = Number(snapped.toFixed(6));
    return Math.min(max, Math.max(min, clean));
  };

  const commit = (raw: number) => {
    const next = clamp(raw);
    setText(String(next));
    setRange(next !== raw && Number.isFinite(raw) ? t("ui.number.range", { min, max }) : null);
    if (next !== value) onCommit(next);
  };

  const commitText = () => {
    const parsed = Number(text.trim().replace(",", "."));
    if (text.trim() === "" || !Number.isFinite(parsed)) {
      setText(String(value));
      setRange(null);
      return;
    }
    commit(parsed);
  };

  const describedBy = range ? `${fieldId}-range` : hint ? `${fieldId}-hint` : ariaDescribedBy;

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {label ? (
        <label htmlFor={fieldId} className="text-sm font-medium text-text-muted">
          {label}
        </label>
      ) : null}
      <div
        className={cn(
          "flex h-control-md items-stretch overflow-hidden rounded-md border border-border-input bg-surface-sunken",
          "focus-within:border-accent hover:border-text-muted",
          disabled && "border-border hover:border-border",
        )}
      >
        <button type="button" tabIndex={-1} aria-label={t("ui.number.decrease")} className={stepButton} disabled={disabled || value <= min} onClick={() => commit(value - step)}>
          <Minus className="size-3.5" aria-hidden />
        </button>
        <input
          id={fieldId}
          role="spinbutton"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          aria-label={label ? undefined : ariaLabel}
          aria-labelledby={label ? undefined : ariaLabelledBy}
          aria-describedby={describedBy}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-valuetext={unit ? `${value} ${unit}` : undefined}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setRange(null);
          }}
          onBlur={commitText}
          onKeyDown={(event) => {
            const big = largeStep ?? step * 10;
            const jump: Record<string, number> = { ArrowUp: value + step, ArrowDown: value - step, PageUp: value + big, PageDown: value - big, Home: min, End: max };
            if (event.key === "Enter") {
              event.preventDefault();
              commitText();
            } else if (event.key === "Escape" && text !== String(value)) {
              // Discard the input first; a second Esc then closes the dialog.
              event.preventDefault();
              event.stopPropagation();
              setText(String(value));
              setRange(null);
            } else if (event.key in jump && !event.altKey && !event.ctrlKey && !event.metaKey) {
              // Home/End remain cursor keys while typing.
              if ((event.key === "Home" || event.key === "End") && text !== String(value)) return;
              event.preventDefault();
              commit(jump[event.key]!);
            }
          }}
          className="w-full min-w-0 flex-1 bg-transparent px-1 text-center text-base text-text tabular-nums outline-none disabled:text-text-disabled"
        />
        {unit ? (
          <span aria-hidden className="flex shrink-0 items-center pr-1.5 text-sm text-text-muted">
            {unit}
          </span>
        ) : null}
        <button type="button" tabIndex={-1} aria-label={t("ui.number.increase")} className={stepButton} disabled={disabled || value >= max} onClick={() => commit(value + step)}>
          <Plus className="size-3.5" aria-hidden />
        </button>
      </div>
      {range ? (
        <p id={`${fieldId}-range`} role="status" className="text-sm text-warning">
          {range}
        </p>
      ) : hint ? (
        <p id={`${fieldId}-hint`} className="text-sm text-text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
