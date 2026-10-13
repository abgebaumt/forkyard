/**
 * Building blocks of the issue view: state icon, labels, people and the full-area states
 * (not connected, token expired, no permission, quota used up …).
 */
import type { ReactNode } from "react";
import { CircleCheck, CircleDot, Hourglass, KeyRound, Lock, Plug, RefreshCw, SearchX, TriangleAlert, Unplug, WifiOff } from "lucide-react";
import { openIntegrations } from "../../app/actions/hosts";
import { describeHostError, hostKindLabels, type HostErrorKind, type HostRepo, type HostUser } from "../../app/actions/hostTypes";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/Feedback";
import { Avatar } from "../../ui/Git";
import { cn } from "../../ui/cn";
import { Badge } from "../Preferences/parts";
import { t } from "../../i18n";
import type { IssueState } from "./api";
import { localizeTimes, retryTime, stateLabels } from "./model";

export function StateIcon({ state, className }: { state: IssueState; className?: string }) {
  return state === "open" ? <CircleDot className={cn("size-icon shrink-0 text-success", className)} aria-hidden /> : <CircleCheck className={cn("size-icon shrink-0 text-text-muted", className)} aria-hidden />;
}

export function StateBadge({ state }: { state: IssueState }) {
  return (
    <Badge tone={state === "open" ? "success" : "neutral"} icon={<StateIcon state={state} className="size-3" />}>
      {stateLabels[state]}
    </Badge>
  );
}

/** Labels as badges – without the host's colours (the app sticks to its own readable tones). */
export function Labels({ labels, max }: { labels: string[]; max?: number }) {
  if (labels.length === 0) return null;
  const shown = max === undefined ? labels : labels.slice(0, max);
  const rest = labels.length - shown.length;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1" data-issue-labels>
      {shown.map((label) => (
        <span key={label} title={label} className="inline-flex h-5 max-w-40 items-center rounded-sm border border-border bg-surface-raised px-1.5 text-xs font-medium text-text-muted">
          <span className="truncate">{label}</span>
        </span>
      ))}
      {rest > 0 ? (
        <span className="text-xs text-text-muted" title={labels.slice(shown.length).join(", ")}>
          +{rest}
        </span>
      ) : null}
    </span>
  );
}

/** A person: initials avatar (nothing from the network) and login. */
export function Person({ user, size = 18 }: { user: HostUser; size?: number }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" title={user.name ? `${user.name} (${user.login})` : user.login}>
      <Avatar name={user.name ?? user.login} size={size} />
      <span className="selectable min-w-0 truncate">{user.login}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Full-area states
// ---------------------------------------------------------------------------

const problemIcons: Partial<Record<HostErrorKind, typeof Plug>> = {
  not_connected: Unplug,
  auth: KeyRound,
  rate_limit: Hourglass,
  not_found: SearchX,
  unsupported: Unplug,
  permission: Lock,
  offline: WifiOff,
  not_built: TriangleAlert,
  other: TriangleAlert,
};

/** Title in this view's words; sentence and hint come from the host integration (the core's message takes precedence). */
const problemTitles: Partial<Record<HostErrorKind, string>> = {
  not_found: t("issues.problem.notFound"),
  permission: t("issues.problem.permission"),
  rate_limit: t("issues.problem.rateLimit"),
  offline: t("issues.problem.offline"),
  other: t("issues.problem.other"),
};

const problemHints: Partial<Record<HostErrorKind, string>> = {
  not_found: t("issues.problem.notFoundHint"),
  permission: t("issues.problem.permissionHint"),
};

export interface ProblemProps {
  error: unknown;
  onRetry: () => void;
  retrying?: boolean;
  /** Narrow version for the detail view. */
  compact?: boolean;
}

/** Error of the host integration as an understandable state with the fitting next step. */
export function HostProblem({ error, onRetry, retrying }: ProblemProps) {
  const info = describeHostError(error);
  // The core reports "token rejected" (401) and "access denied" (403) under the same code; the message tells them apart.
  const forbidden = info.kind === "auth" && /verweigert|Berechtigung|denied|permission/i.test(info.text);
  const kind: HostErrorKind = forbidden ? "permission" : info.kind;
  const Icon = problemIcons[kind] ?? TriangleAlert;
  const needsAccount = info.kind === "auth" || info.kind === "not_connected";
  const time = info.kind === "rate_limit" ? retryTime(info.text) : null;
  const hint = problemHints[kind] ?? info.hint;
  return (
    <div data-issues-state={kind} role={info.kind === "rate_limit" ? "status" : "alert"} className="flex min-h-0 flex-1 items-center justify-center overflow-auto">
      <EmptyState
        icon={<Icon className={cn("size-8", kind === "rate_limit" ? "text-warning" : kind === "other" || kind === "auth" ? "text-danger" : undefined)} aria-hidden />}
        title={problemTitles[kind] ?? info.title}
        action={
          <span className="flex flex-wrap justify-center gap-2">
            {needsAccount ? (
              <Button variant="primary" icon={<Plug className="size-icon" aria-hidden />} onClick={openIntegrations}>
                {t("issues.problem.openIntegrations")}
              </Button>
            ) : null}
            {info.kind === "not_built" || info.kind === "unsupported" ? null : (
              <Button loading={retrying} icon={<RefreshCw className="size-icon" aria-hidden />} onClick={onRetry}>
                {t("issues.problem.retry")}
              </Button>
            )}
          </span>
        }
      >
        {/* The core states timestamps in UTC; here they appear in local time. */}
        <span className="selectable block break-words" data-retry-at={time ?? undefined}>
          {localizeTimes(info.text)}
        </span>
        {hint ? <span className="mt-1 block">{hint}</span> : null}
      </EmptyState>
    </div>
  );
}

/** The repository's host is detected, but no account is connected for it. */
export function NotConnected({ repo }: { repo: HostRepo }) {
  const host = repo.kind ? hostKindLabels[repo.kind] : t("issues.notConnected.fallbackHost");
  return (
    <div data-issues-state="not_connected" className="flex min-h-0 flex-1 items-center justify-center overflow-auto">
      <EmptyState
        icon={<Unplug className="size-8" aria-hidden />}
        title={t("issues.notConnected.title", { host })}
        action={
          <Button variant="primary" icon={<Plug className="size-icon" aria-hidden />} onClick={openIntegrations}>
            {t("issues.notConnected.connect")}
          </Button>
        }
      >
        {t("issues.notConnected.text", { host, repo: `${repo.owner}/${repo.name}` })}
      </EmptyState>
    </div>
  );
}

/** No supported host can be derived from the repository's remotes. */
export function NoHost() {
  return (
    <div data-issues-state="no_host" className="flex min-h-0 flex-1 items-center justify-center overflow-auto">
      <EmptyState icon={<Unplug className="size-8" aria-hidden />} title={t("issues.noHost.title")}>
        {t("issues.noHost.text")}
      </EmptyState>
    </div>
  );
}

export function Blank({ state, icon, title, children, action }: { state: string; icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div data-issues-state={state} className="flex min-h-0 flex-1 items-center justify-center overflow-auto">
      <EmptyState icon={icon} title={title} action={action}>
        {children}
      </EmptyState>
    </div>
  );
}
