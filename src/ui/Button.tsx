import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "./cn";
import { Tip } from "./Tooltip";
import { t } from "../i18n";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const base =
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap " +
  "transition-[background-color,border-color,filter] " +
  "disabled:pointer-events-none disabled:bg-surface-raised disabled:text-text-disabled disabled:border-transparent";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent hover:brightness-110 active:brightness-95",
  secondary:
    "border border-border bg-surface-raised text-text hover:border-border-input active:bg-surface",
  ghost: "text-text hover:bg-surface-raised active:bg-surface",
  danger: "bg-danger text-on-danger hover:brightness-110 active:brightness-95",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-control-sm px-2 text-sm",
  md: "h-control-md px-3 text-base",
  lg: "h-control-lg px-4 text-md",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and disables the button. The label stays available to screen readers. */
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(base, variants[variant], sizes[size], loading && "pointer-events-none", className)}
      disabled={disabled}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      {...rest}
    >
      {loading ? <Loader2 className="size-icon animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

const iconSizes: Record<ButtonSize | "xs", string> = {
  // For the status bar (24 px high including the border): a 24 px button would overflow at the bottom.
  xs: "size-5 rounded-sm",
  sm: "size-control-sm",
  md: "size-control-md",
  lg: "size-control-lg",
};

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** Required: used as aria-label and as the tooltip. */
  label: string;
  shortcut?: string;
  icon: ReactNode;
  size?: ButtonSize | "xs";
  active?: boolean;
  danger?: boolean;
}

export function IconButton({
  label,
  shortcut,
  icon,
  size = "md",
  active = false,
  danger = false,
  className,
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <Tip label={label} shortcut={shortcut}>
      <button
        type={type}
        aria-label={label}
        aria-pressed={active || undefined}
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-md transition-colors",
          "text-text-muted hover:bg-surface-raised hover:text-text active:bg-surface",
          "disabled:pointer-events-none disabled:text-text-disabled",
          active && "bg-accent-surface text-accent hover:bg-accent-surface hover:text-accent",
          danger && "hover:text-danger",
          iconSizes[size],
          className,
        )}
        {...rest}
      >
        {icon}
      </button>
    </Tip>
  );
}

export function Spinner({ label = t("ui.loading") }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-1.5 text-text-muted">
      <Loader2 className="size-icon animate-spin" aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}
