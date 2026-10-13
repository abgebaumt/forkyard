import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { Dialog as RadixDialog } from "radix-ui";
import { Button } from "./Button";
import { cn } from "./cn";
import { t } from "../i18n";

export type DialogSize = "sm" | "md" | "lg";

// Widths from tokens.json › layout.dialog (400, 560, 760), as multiples of the grid (--spacing).
const widths: Record<DialogSize, string> = {
  sm: "w-100",
  md: "w-140",
  lg: "w-190",
};

export const dialogSurface =
  // vh and vw do not grow with the app's zoom (CSS zoom on the root element): divide by `--zoom`.
  "flex max-h-[calc(85vh/var(--zoom,1))] max-w-[calc(100vw/var(--zoom,1)-var(--spacing)*8)] flex-col rounded-lg border border-border bg-surface text-text shadow-dialog";

/**
 * If focus is on the frame of a dialog (the focused control has disappeared), Shift+Tab leads to the
 * last control – just as Tab leads to the first. Radix's focus trap only knows the cases "Tab on
 * the last" and "Shift+Tab on the first element": from the frame, Shift+Tab would run out of the
 * dialog, and the trap would pull focus back to the frame every time (focus stuck on the frame).
 */
export function shiftTabFromFrame(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== "Tab" || !event.shiftKey || event.target !== event.currentTarget) return;
  const stops = [...event.currentTarget.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]")].filter(
    (element) => element.tabIndex >= 0 && !element.hasAttribute("disabled") && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden",
  );
  const last = stops[stops.length - 1];
  if (!last) return;
  event.preventDefault();
  last.focus();
}

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  size?: DialogSize;
  children?: ReactNode;
  footer?: ReactNode;
}

export function Dialog({ open, onOpenChange, title, description, size = "md", children, footer }: DialogProps) {
  // Who had focus before the dialog opened? Radix only remembers that after mounting –
  // by then a field with autoFocus already has focus, and on close it would go nowhere.
  const opener = useRef<Element | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) opener.current = typeof document === "undefined" ? null : document.activeElement;
  wasOpen.current = open;
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="animate-fade fixed inset-0 z-40 bg-surface-sunken/70" />
        <RadixDialog.Content
          onKeyDown={shiftTabFromFrame}
          onOpenAutoFocus={(event) => {
            // React autoFocus does not work reliably in Radix dialogs (in the portal, and over another
            // modal dialog its focus trap pulls focus back); Radix then focused the first
            // control – the close button. An element with data-autofocus gets focus explicitly.
            const content = event.currentTarget;
            const target = content instanceof HTMLElement ? content.querySelector<HTMLElement>("[data-autofocus]") : null;
            if (target) {
              event.preventDefault();
              target.focus();
            }
          }}
          onCloseAutoFocus={(event) => {
            // Radix only returns focus in a timer after unmounting. If another dialog is open by then
            // (the next prompt: first username, then password), focus stays there –
            // otherwise the old dialog would pull it out of the new field, and the input would go nowhere.
            const active = document.activeElement;
            if (active instanceof HTMLElement && active !== document.body && active.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')) {
              event.preventDefault();
              return;
            }
            const element = opener.current;
            if (element instanceof HTMLElement && element.isConnected && element !== document.body) {
              event.preventDefault();
              element.focus();
            }
          }}
          className={cn(
            dialogSurface,
            widths[size],
            "animate-pop fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
          )}
        >
          <header className="flex items-start gap-3 px-4 pt-4">
            {/* min-w-0: long names and lists in the description get truncated instead of blowing up the dialog. */}
            <div className="min-w-0 flex-1">
              <RadixDialog.Title className="text-lg font-semibold">{title}</RadixDialog.Title>
              {description ? (
                <RadixDialog.Description className="mt-1 text-base text-text-muted">
                  {description}
                </RadixDialog.Description>
              ) : null}
            </div>
            <RadixDialog.Close
              aria-label={t("ui.close")}
              className="inline-flex size-control-sm items-center justify-center rounded-md text-text-muted hover:bg-surface-raised hover:text-text"
            >
              <X className="size-icon" aria-hidden />
            </RadixDialog.Close>
          </header>
          {children ? <div className="min-h-0 flex-1 overflow-auto px-4 py-4">{children}</div> : null}
          {footer ? <footer className="flex justify-end gap-2 px-4 pt-2 pb-4">{footer}</footer> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Says concretely what will be lost. Required for destructive actions. */
  description: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          {/* Cancel comes first and gets focus: Enter never triggers destruction by accident. */}
          <Button autoFocus data-autofocus onClick={() => onOpenChange(false)}>
            {t("ui.cancel")}
          </Button>
          <Button variant={danger ? "danger" : "primary"} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
