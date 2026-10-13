/**
 * Shared parts of the conflict tool: header, hint strip, loading and error state.
 */
import { FileQuestion, RefreshCw, TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import type { CoreError } from "../../core";
import { describeError } from "../../app/errors";
import { Button, IconButton } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { StatusBadge } from "../../ui/Git";
import { Tip } from "../../ui/Tooltip";
import { t } from "../../i18n";
import { Trans } from "react-i18next";

export function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? { dir: "", name: path } : { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

export function Divider() {
  return <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />;
}

export function Tag({ children, title, data }: { children: ReactNode; title?: string; data?: string }) {
  return (
    <span title={title} data-tag={data} className="shrink-0 rounded-sm border border-border px-1.5 text-xs font-medium whitespace-nowrap text-text-muted">
      {children}
    </span>
  );
}

export interface ToolHeaderProps {
  path: string;
  /** Addition after the name, e.g. progress. */
  middle?: ReactNode;
  /** On the right before “Close”, e.g. navigation. */
  end?: ReactNode;
  /** Zweite Zeile: Werkzeuge. */
  toolbar?: ReactNode;
  onClose: () => void;
}

/** Header: status “Conflict”, file name, folder, addition, close. */
export function ToolHeader({ path, middle, end, toolbar, onClose }: ToolHeaderProps) {
  const { dir, name } = splitPath(path);
  return (
    <header data-conflict-header="" className="shrink-0 border-b border-border bg-surface">
      <div className="flex h-control-lg items-center gap-2 pr-1 pl-3">
        <StatusBadge status="conflicted" />
        <Tip label={<span className="font-mono text-code break-all">{path}</span>}>
          <h2 data-conflict-title="" className="m-0 flex min-w-0 flex-1 items-baseline gap-2 text-base font-normal">
            <span className="min-w-8 shrink truncate font-medium text-text">{name}</span>
            {dir ? <span className="min-w-0 shrink-4 truncate text-sm text-text-muted">{dir}</span> : null}
          </h2>
        </Tip>
        {middle}
        {end}
        <Divider />
        <IconButton size="sm" label={t("conflict.header.close")} shortcut="Escape" icon={<X className="size-icon" aria-hidden />} onClick={onClose} />
      </div>
      {toolbar}
    </header>
  );
}

/** Narrow hint above the content. */
export function Strip({ children, action, tone = "muted", id }: { children: ReactNode; action?: ReactNode; tone?: "muted" | "warning" | "danger"; id?: string }) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      data-strip={id}
      className={cn(
        "flex min-h-control-md shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-sm",
        tone === "warning" ? "bg-warning-surface text-text" : tone === "danger" ? "bg-danger-surface text-text" : "bg-surface text-text-muted",
      )}
    >
      {tone !== "muted" ? <TriangleAlert className={cn("size-icon shrink-0", tone === "danger" ? "text-danger" : "text-warning")} aria-hidden /> : null}
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

/** Centred hint for the whole area (error, no longer in conflict). */
export function Notice({ icon, title, children, action, tone = "muted", id }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode; tone?: "muted" | "danger"; id?: string }) {
  return (
    <div data-notice={id} role={tone === "danger" ? "alert" : "status"} className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-auto bg-surface-sunken px-6 py-8 text-center">
      <span className={tone === "danger" ? "text-danger" : "text-text-muted"}>{icon}</span>
      <p className="max-w-full text-md font-medium text-text">{title}</p>
      {children ? <div className="selectable max-w-md text-base text-text-muted">{children}</div> : null}
      {action ? <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

const skeletonWidths = ["w-3/5", "w-2/5", "w-4/5", "w-1/2", "w-3/4", "w-2/5", "w-2/3", "w-1/3"];

function SkeletonLines({ count }: { count: number }) {
  return (
    <div className="gc-cf-skeleton flex flex-col gap-2 px-3 py-3">
      {skeletonWidths.slice(0, count).map((width, index) => (
        <div key={index} className="flex items-center gap-3">
          <span className="h-2.5 w-6 shrink-0 rounded-sm bg-surface-raised" />
          <span className={cn("h-2.5 rounded-sm bg-surface-raised", width)} />
        </div>
      ))}
    </div>
  );
}

/** Loading state: the shape of the tool without content. */
export function ConflictSkeleton() {
  return (
    <div role="status" aria-label={t("conflict.loading")} data-conflict-loading="" className="flex min-h-0 flex-1 flex-col bg-surface-sunken">
      <div className="h-control-lg shrink-0 border-b border-border bg-surface" />
      <div className="grid min-h-0 flex-1 grid-cols-2">
        <SkeletonLines count={8} />
        <div className="border-l border-border">
          <SkeletonLines count={6} />
        </div>
      </div>
      <div className="h-control-lg shrink-0 border-y border-border bg-surface" />
      <div className="min-h-0 flex-1">
        <SkeletonLines count={7} />
      </div>
    </div>
  );
}

export function ConflictError({ error, path, retrying, onRetry, onClose }: { error: CoreError; path: string; retrying: boolean; onRetry: () => void; onClose: () => void }) {
  if (error.code === "not_found" || error.code === "path_not_found") {
    return (
      <Notice
        id="gone"
        icon={<FileQuestion className="size-8" aria-hidden />}
        title={t("conflict.error.goneTitle")}
        action={
          <>
            <Button variant="primary" onClick={onClose}>
              {t("conflict.error.backToChanges")}
            </Button>
            <Button loading={retrying} icon={<RefreshCw className="size-icon" aria-hidden />} onClick={onRetry}>
              {t("conflict.error.recheck")}
            </Button>
          </>
        }
      >
        <p>
          <Trans i18nKey="conflict.error.goneBody" values={{ path }} components={{ path: <span className="font-mono text-code break-all" /> }} />
        </p>
      </Notice>
    );
  }
  const { text, hint } = describeError(error);
  return (
    <Notice
      id="error"
      tone="danger"
      icon={<TriangleAlert className="size-8" aria-hidden />}
      title={t("conflict.error.title")}
      action={
        <>
          <Button loading={retrying} icon={<RefreshCw className="size-icon" aria-hidden />} onClick={onRetry}>
            {t("conflict.error.retry")}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t("conflict.error.close")}
          </Button>
        </>
      }
    >
      <p>{text}</p>
      {hint ? <p>{hint}</p> : null}
    </Notice>
  );
}
