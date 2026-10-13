import { Switch as RadixSwitch } from "radix-ui";
import { cn } from "./cn";

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  /** Without a visible <label htmlFor>, one of the two is required. */
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
}

/**
 * Switch for settings that take effect immediately. Radix Switch (role=switch): Space and Enter
 * toggle. On and off differ by the position of the knob, not only by colour.
 */
export function Switch({ checked, onCheckedChange, disabled, id, ariaLabel, ariaLabelledBy, ariaDescribedBy }: SwitchProps) {
  return (
    <RadixSwitch.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      className={cn(
        "group inline-flex h-5 w-9 shrink-0 items-center rounded-pill border border-border-input bg-surface-sunken px-0.5 transition-colors",
        "hover:border-text-muted data-[state=checked]:border-accent data-[state=checked]:bg-accent",
        "disabled:border-border disabled:bg-surface disabled:data-[state=checked]:bg-surface-raised",
      )}
    >
      <RadixSwitch.Thumb
        className={cn(
          "block size-3.5 rounded-pill bg-text-muted transition-transform",
          "data-[state=checked]:translate-x-4 data-[state=checked]:bg-on-accent",
          "group-disabled:bg-text-disabled",
        )}
      />
    </RadixSwitch.Root>
  );
}
