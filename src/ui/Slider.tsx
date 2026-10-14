/**
 * Horizontal slider on top of Radix Slider (role=slider): arrow keys move by `step`, Home/End to the ends.
 */
import { Slider as RadixSlider } from "radix-ui";
import { cn } from "./cn";

export interface SliderProps {
  /** Name for screen readers, e.g. "Opacity of the new version". */
  label: string;
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Spoken value, e.g. "40 %". */
  valueText?: string;
  className?: string;
}

export function Slider({ label, value, onValueChange, min = 0, max = 100, step = 1, valueText, className }: SliderProps) {
  return (
    <RadixSlider.Root
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={(next) => {
        const first = next[0];
        if (first !== undefined) onValueChange(first);
      }}
      className={cn("relative flex h-control-sm w-40 touch-none items-center select-none", className)}
    >
      <RadixSlider.Track className="relative h-1 grow overflow-hidden rounded-full bg-surface-raised">
        <RadixSlider.Range className="absolute h-full bg-accent" />
      </RadixSlider.Track>
      <RadixSlider.Thumb
        aria-label={label}
        aria-valuetext={valueText}
        className="block size-3.5 rounded-full border border-border-input bg-surface hover:border-text-muted focus-visible:outline-2 focus-visible:outline-accent"
      />
    </RadixSlider.Root>
  );
}
