/**
 * Building blocks of the pull request view and the section in the left panel: state, checks and
 * reviews always as a word; icon and colour only come on top.
 */
import type { ComponentType, ReactNode } from "react";
import { CircleCheck, CircleDashed, CircleX, Clock, GitMerge, GitPullRequestArrow, GitPullRequestClosed, GitPullRequestDraft, MessageSquare, MessageSquareWarning, ThumbsUp } from "lucide-react";
import type { CheckState, HostCapabilities, HostUser, PrCheck, PrState, PrSummary } from "../../app/actions/hostTypes";
import { formatDateTime, formatRelative } from "../../app/format";
import { cn } from "../../ui/cn";
import { t } from "../../i18n";

type Icon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

export type PrPhase = "open" | "draft" | "merged" | "closed";

export const prPhase = (pr: Pick<PrSummary, "state" | "isDraft">): PrPhase => (pr.state === "open" ? (pr.isDraft ? "draft" : "open") : pr.state);

export const phaseInfo: Record<PrPhase, { label: string; icon: Icon; tone: string; badge: string }> = {
  open: { label: t("pullRequest.view.phase.open"), icon: GitPullRequestArrow, tone: "text-success", badge: "border-transparent bg-success-surface text-text" },
  draft: { label: t("pullRequest.view.phase.draft"), icon: GitPullRequestDraft, tone: "text-text-muted", badge: "border-border bg-surface-raised text-text-muted" },
  merged: { label: t("pullRequest.view.phase.merged"), icon: GitMerge, tone: "text-accent", badge: "border-transparent bg-accent-surface text-text" },
  closed: { label: t("pullRequest.view.phase.closed"), icon: GitPullRequestClosed, tone: "text-danger", badge: "border-transparent bg-danger-surface text-text" },
};

export const stateLabels: Record<PrState, string> = { open: t("pullRequest.view.phase.open"), closed: t("pullRequest.view.phase.closed"), merged: t("pullRequest.view.phase.merged") };

/** Badge with the pull request's state. */
export function PhaseBadge({ pr, className }: { pr: Pick<PrSummary, "state" | "isDraft">; className?: string }) {
  const phase = prPhase(pr);
  const info = phaseInfo[phase];
  const IconComponent = info.icon;
  return (
    <span data-pr-phase={phase} className={cn("inline-flex h-6 shrink-0 items-center gap-1 rounded-sm border px-2 text-sm font-medium whitespace-nowrap", info.badge, className)}>
      <IconComponent className={cn("size-3.5", info.tone)} aria-hidden />
      {info.label}
    </span>
  );
}

export const checkInfo: Record<CheckState, { label: string; icon: Icon; tone: string }> = {
  passing: { label: t("pullRequest.view.check.passing"), icon: CircleCheck, tone: "text-success" },
  failing: { label: t("pullRequest.view.check.failing"), icon: CircleX, tone: "text-danger" },
  pending: { label: t("pullRequest.view.check.pending"), icon: Clock, tone: "text-warning" },
};

/** "Checks: 3 passed", "1 of 3 failed", "2 of 3 still running", "none". */
export function checksText(summary: CheckState | null, runs: Pick<PrCheck, "state">[] = []): string {
  if (!summary) return t("pullRequest.view.check.none");
  const total = runs.length;
  const count = (state: CheckState) => runs.filter((run) => run.state === state).length;
  if (summary === "failing") return total ? t("pullRequest.view.check.failingOf", { count: count("failing"), total }) : t("pullRequest.view.check.failingAll");
  if (summary === "pending") return total ? t("pullRequest.view.check.pendingOf", { count: count("pending"), total }) : t("pullRequest.view.check.pendingAll");
  return total ? (total === 1 ? t("pullRequest.view.check.passingOne") : t("pullRequest.view.check.passingOf", { total })) : t("pullRequest.view.check.passingAll");
}

export function ChecksSummary({ summary, runs, className }: { summary: CheckState | null; runs?: Pick<PrCheck, "state">[]; className?: string }) {
  const IconComponent = summary ? checkInfo[summary].icon : CircleDashed;
  return (
    <span data-checks={summary ?? "none"} className={cn("inline-flex min-w-0 items-center gap-1 text-sm", summary ? "text-text" : "text-text-muted", className)}>
      <IconComponent className={cn("size-3.5 shrink-0", summary ? checkInfo[summary].tone : "text-text-muted")} aria-hidden />
      <span className="truncate">{checksText(summary, runs)}</span>
    </span>
  );
}

const reviewInfo: Record<string, { label: string; icon: Icon; tone: string }> = {
  approved: { label: t("pullRequest.view.review.approved"), icon: ThumbsUp, tone: "text-success" },
  changes_requested: { label: t("pullRequest.view.review.changesRequested"), icon: MessageSquareWarning, tone: "text-danger" },
  commented: { label: t("pullRequest.view.review.commented"), icon: MessageSquare, tone: "text-text-muted" },
  review_required: { label: t("pullRequest.view.review.required"), icon: Clock, tone: "text-warning" },
  review_requested: { label: t("pullRequest.view.review.requested"), icon: Clock, tone: "text-warning" },
  requested: { label: t("pullRequest.view.review.requested"), icon: Clock, tone: "text-warning" },
  pending: { label: t("pullRequest.view.review.required"), icon: Clock, tone: "text-warning" },
  dismissed: { label: t("pullRequest.view.review.dismissed"), icon: CircleDashed, tone: "text-text-muted" },
};

/** What the review state is called in the UI; unknown values from the host are shown unchanged. */
export function reviewLabel(state: string | null): string | null {
  if (!state || state === "none") return null;
  return reviewInfo[state.toLowerCase()]?.label ?? state;
}

export function ReviewState({ state, className }: { state: string | null; className?: string }) {
  const label = reviewLabel(state);
  if (!label || !state) return null;
  const info = reviewInfo[state.toLowerCase()];
  const IconComponent = info?.icon ?? CircleDashed;
  return (
    <span data-review={state} className={cn("inline-flex min-w-0 items-center gap-1 text-sm text-text", className)}>
      <IconComponent className={cn("size-3.5 shrink-0", info?.tone ?? "text-text-muted")} aria-hidden />
      <span className="truncate">{label}</span>
    </span>
  );
}

export const userName = (user: HostUser | null) => user?.name ?? user?.login ?? t("pullRequest.view.unknownUser");

/** Relative date with the exact one in the tooltip; empty if the host gives none. */
export function When({ value, prefix }: { value: string | null; prefix?: string }) {
  if (!value) return null;
  return (
    <time dateTime={value} title={formatDateTime(value)} className="whitespace-nowrap">
      {prefix ? `${prefix} ` : ""}
      {formatRelative(value)}
    </time>
  );
}

/** Branch name as a badge in monospace; not truncated in the middle – the full name is in the tooltip. */
export function BranchChip({ name, label }: { name: string; label: string }) {
  return (
    <span title={`${label}: ${name}`} className="selectable inline-block max-w-64 truncate rounded-sm border border-border bg-surface-raised px-1.5 align-middle font-mono text-code text-text">
      {name}
    </span>
  );
}

/** Heading of a section in the conversation. */
export function BlockTitle({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <h3 className="mb-1 flex items-baseline gap-2 text-xs font-semibold tracking-wide text-text-muted uppercase">
      {children}
      {count !== undefined ? <span className="font-normal tabular-nums">{count}</span> : null}
    </h3>
  );
}

/** Labels of a pull request; left out entirely for hosts without labels (Bitbucket). */
export function LabelsBlock({ labels, capabilities }: { labels: string[]; capabilities: Pick<HostCapabilities, "prLabels"> }) {
  if (!capabilities.prLabels) return null;
  return (
    <section aria-label={t("pullRequest.view.labels")} data-pr-labels="">
      <BlockTitle count={labels.length || undefined}>{t("pullRequest.view.labels")}</BlockTitle>
      {labels.length === 0 ? (
        <p className="text-base text-text-muted">{t("pullRequest.view.noLabels")}</p>
      ) : (
        <ul className="flex flex-wrap gap-1">
          {labels.map((label) => (
            <li key={label} title={label} className="selectable max-w-full truncate rounded-pill border border-border bg-surface-raised px-2 text-sm text-text">
              {label}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
