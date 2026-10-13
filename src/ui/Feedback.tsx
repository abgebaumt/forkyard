import { useSyncExternalStore, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, OctagonAlert, X } from "lucide-react";
import { Toast as RadixToast } from "radix-ui";
import { cn } from "./cn";
import { t } from "../i18n";

export type Tone = "info" | "success" | "warning" | "danger";

const toneIcon: Record<Tone, ReactNode> = {
  info: <Info className="size-icon text-accent" aria-hidden />,
  success: <CheckCircle2 className="size-icon text-success" aria-hidden />,
  warning: <AlertTriangle className="size-icon text-warning" aria-hidden />,
  danger: <OctagonAlert className="size-icon text-danger" aria-hidden />,
};

const bannerTone: Record<Tone, string> = {
  info: "bg-accent-surface",
  success: "bg-success-surface",
  warning: "bg-warning-surface",
  danger: "bg-danger-surface",
};

export interface BannerProps {
  tone?: Tone;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}

/** Persistent notice in the panel, e.g. detached HEAD or a merge in progress. */
export function Banner({ tone = "info", title, children, actions }: BannerProps) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn("flex items-start gap-2 px-3 py-2 text-base text-text", bannerTone[tone])}
    >
      <span className="mt-0.5">{toneIcon[tone]}</span>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        {children ? <div className="text-sm text-text-muted">{children}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 gap-1">{actions}</div> : null}
    </div>
  );
}

export interface ToastData {
  id: number;
  tone: Tone;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  /** Stays until it is closed – for notices with an action that need time to read. Errors always stay. */
  sticky?: boolean;
  /** When the message appeared (set by `toast()`). */
  at?: number;
}

/** Presentation of a toast without behaviour. */
export function ToastCard({ toast, onClose }: { toast: Omit<ToastData, "id">; onClose?: () => void }) {
  return (
    <div className="flex w-80 items-start gap-2 rounded-lg border border-border bg-surface-raised p-3 text-base text-text shadow-pop">
      <span className="mt-0.5">{toneIcon[toast.tone]}</span>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{toast.title}</p>
        {toast.description ? (
          <p className="selectable text-sm break-words whitespace-pre-line text-text-muted">{toast.description}</p>
        ) : null}
        {toast.action ? (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick();
              // The message has served its purpose (errors stay until they are closed).
              if (toast.tone !== "danger") onClose?.();
            }}
            className="mt-1 rounded-sm text-sm font-medium text-accent hover:underline"
          >
            {toast.action.label}
          </button>
        ) : null}
      </div>
      {onClose ? (
        <button
          type="button"
          aria-label={t("ui.toast.close")}
          onClick={onClose}
          className="inline-flex size-5 items-center justify-center rounded-sm text-text-muted hover:bg-surface hover:text-text"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

// Small store for toasts, so that every part of the app can call `toast(...)`.
let toasts: ToastData[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

/** Never more messages than this at once; the oldest give way. */
export const MAX_TOASTS = 4;

/** Minimum time a message stays before it goes away by itself or gives way to a newer one. */
const TOAST_TIME = 5000;

export function toast(data: Omit<ToastData, "id">): number {
  const id = nextId++;
  const now = Date.now();
  // The same message again (e.g. the same error after another click) replaces the old one instead of stacking.
  // A success message with an action button stays as long as it is the newest message; once it has had
  // its time, it gives way to the next message – otherwise "… [Undo]" messages would pile up.
  const others = toasts.filter(
    (item) =>
      !(item.tone === data.tone && item.title === data.title && item.description === data.description) &&
      !(isTransient(item) && item.action !== undefined && now - (item.at ?? now) >= TOAST_TIME),
  );
  toasts = [...others, { ...data, id, at: now }].slice(-MAX_TOASTS);
  emit();
  return id;
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((item) => item.id !== id);
  emit();
}

/** Messages that disappear by themselves (no errors, not "sticky"). */
const isTransient = (item: ToastData) => item.tone !== "danger" && !item.sticky;

export function hasTransientToasts(): boolean {
  return toasts.some(isTransient);
}

/** Closes all messages that would disappear by themselves anyway (see src/app/escapeGuard.ts). */
export function dismissTransientToasts(): void {
  if (!toasts.some(isTransient)) return;
  toasts = toasts.filter((item) => !isTransient(item));
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Mount once at the root of the app. */
export function Toaster() {
  const items = useSyncExternalStore(subscribe, () => toasts);
  return (
    <RadixToast.Provider swipeDirection="right" label={t("ui.toast.region")}>
      {items.map((item) => (
        <RadixToast.Root
          key={item.id}
          // Errors stay until they are closed – and so do messages with an action button: anyone who
          // wants to reach it by keyboard or screen reader (F8, Tab, Enter) cannot do that in
          // five seconds. Everything else disappears by itself.
          duration={item.tone === "danger" || item.sticky || item.action ? Infinity : TOAST_TIME}
          type={item.tone === "danger" ? "foreground" : "background"}
          onOpenChange={(open) => {
            if (!open) dismissToast(item.id);
          }}
          // Esc closes like the close button. Otherwise Radix would move focus to the (invisible)
          // list of messages and pause the timers of all later messages there.
          onEscapeKeyDown={(event) => {
            // Only when focus is INSIDE a message (F8, Tab): then Esc closes exactly that one. Otherwise
            // nothing changes – Esc belongs to the dialog or palette underneath (see escapeGuard.ts).
            const focused = document.activeElement instanceof Element ? document.activeElement.closest("[data-toast-id]") : null;
            if (!focused) return;
            event.preventDefault();
            dismissToast(Number(focused.getAttribute("data-toast-id")));
          }}
          className="animate-pop"
          data-toast={item.tone}
          data-toast-id={item.id}
        >
          <RadixToast.Title className="sr-only">{item.title}</RadixToast.Title>
          <ToastCard toast={item} onClose={() => dismissToast(item.id)} />
        </RadixToast.Root>
      ))}
      <RadixToast.Viewport label={t("ui.toast.viewport")} className="fixed right-3 bottom-9 z-50 flex flex-col gap-2 outline-none" />
    </RadixToast.Provider>
  );
}

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ icon, title, children, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      {icon ? <span className="text-text-muted">{icon}</span> : null}
      <p className="text-md font-medium text-text">{title}</p>
      {children ? <p className="max-w-72 text-base text-text-muted">{children}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
