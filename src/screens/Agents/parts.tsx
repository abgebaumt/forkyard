/** Status of an agent as dot + word (never colour alone); tones from the spec. */
import type { AgentStatus } from "../../core";
import { cn } from "../../ui/cn";
import { statusLabel, statusTone, type StatusTone } from "./model";

const DOT: Record<StatusTone, string> = { accent: "bg-accent", warning: "bg-warning", success: "bg-success", danger: "bg-danger", muted: "bg-text-muted" };

export function StatusDot({ status, className }: { status: AgentStatus; className?: string }) {
  return <span className={cn("inline-flex size-1.5 shrink-0 rounded-full", DOT[statusTone(status)], className)} aria-hidden />;
}

export function StatusWord({ status, origin }: { status: AgentStatus; origin?: string | null }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" data-agent-status={status}>
      <StatusDot status={status} />
      <span className="text-sm text-text">{statusLabel(status)}</span>
      {origin ? <span className="truncate text-xs text-text-muted">{origin}</span> : null}
    </span>
  );
}
