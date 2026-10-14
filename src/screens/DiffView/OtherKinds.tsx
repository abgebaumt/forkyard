/**
 * Everything that is not a text or image diff: binary files, LFS pointers, files that are too large –
 * plus the calm hints for text diffs without hunks, the loading skeleton and the error state.
 */
import { ArrowRight, Binary, FileQuestion, HardDrive, RefreshCw, Scale, TriangleAlert } from "lucide-react";
import { type ReactNode } from "react";
import type { CoreError, FileDiff, FileStatus } from "../../core";
import { describeError } from "../../app/errors";
import { formatBytes } from "../../app/format";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { locale, t } from "../../i18n";
import { Trans } from "react-i18next";

type BinaryDiff = Extract<FileDiff, { kind: "binary" }>;
type LfsDiff = Extract<FileDiff, { kind: "lfs" }>;
type TooLargeDiff = Extract<FileDiff, { kind: "too_large" }>;

const size = (bytes: number | null) => (bytes === null ? "–" : formatBytes(bytes));

/** Calm hint in the middle: icon, one sentence, one explanatory sentence, at most one action. */
export function Notice({ icon, title, children, action, tone = "muted", id }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode; tone?: "muted" | "danger"; id?: string }) {
  return (
    <div data-notice={id} role={tone === "danger" ? "alert" : "status"} className="flex h-full min-h-0 flex-col items-center justify-center gap-2 overflow-auto bg-surface-sunken px-6 py-8 text-center">
      <span className={tone === "danger" ? "text-danger" : "text-text-muted"}>{icon}</span>
      <p className="max-w-full text-md font-medium text-text">{title}</p>
      {children ? <div className="selectable max-w-md text-base text-text-muted">{children}</div> : null}
      {action ? <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Binary, LFS, too large
// ---------------------------------------------------------------------------

/** “before → after” as a small table. */
function BeforeAfter({ rows }: { rows: { label: string; before: ReactNode; after: ReactNode }[] }) {
  return (
    <table className="mx-auto mt-1 border-separate border-spacing-x-3 border-spacing-y-1 text-left text-sm">
      <thead>
        <tr className="text-xs text-text-muted">
          <th scope="col" className="font-medium" />
          <th scope="col" className="font-medium">
            {t("diff.before")}
          </th>
          <th scope="col" aria-hidden />
          <th scope="col" className="font-medium">
            {t("diff.after")}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <th scope="row" className="font-normal text-text-muted">
              {row.label}
            </th>
            <td className="font-mono text-code text-text tabular-nums">{row.before}</td>
            <td aria-hidden className="text-text-muted">
              <ArrowRight className="size-3" />
            </td>
            <td className="font-mono text-code text-text tabular-nums">{row.after}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const statusSentence: Record<FileStatus, string> = {
  modified: t("diff.status.modified"),
  added: t("diff.status.added"),
  untracked: t("diff.status.untracked"),
  deleted: t("diff.status.deleted"),
  renamed: t("diff.status.renamed"),
  conflicted: t("diff.status.conflicted"),
};

export function BinaryDiffView({ diff }: { diff: BinaryDiff }) {
  return (
    <Notice id="binary" icon={<Binary className="size-8" aria-hidden />} title={t("diff.binary.title")}>
      <p>{statusSentence[diff.status]} {t("diff.binary.body")}</p>
      <BeforeAfter rows={[{ label: t("diff.size"), before: size(diff.oldSize), after: size(diff.newSize) }]} />
    </Notice>
  );
}

const shortOid = (oid: string | null) => (oid ? oid.slice(0, 12) : "–");

export function LfsDiffView({ diff }: { diff: LfsDiff }) {
  return (
    <Notice id="lfs" icon={<HardDrive className="size-8" aria-hidden />} title={t("diff.lfs.title")}>
      <p>{statusSentence[diff.status]} {t("diff.lfs.body")}</p>
      <BeforeAfter
        rows={[
          { label: "OID", before: <span title={diff.oldOid ?? undefined}>{shortOid(diff.oldOid)}</span>, after: <span title={diff.newOid ?? undefined}>{shortOid(diff.newOid)}</span> },
          { label: t("diff.size"), before: size(diff.oldSize), after: size(diff.newSize) },
        ]}
      />
    </Notice>
  );
}


export function TooLargeView({ diff, loading, onForce }: { diff: TooLargeDiff; loading: boolean; onForce: () => void }) {
  const detail = diff.lines !== null ? t("diff.tooLarge.detail", { size: formatBytes(diff.bytes), lines: new Intl.NumberFormat(locale()).format(diff.lines) }) : formatBytes(diff.bytes);
  return (
    <Notice
      id="too_large"
      icon={<Scale className="size-8" aria-hidden />}
      title={t("diff.tooLarge.title", { detail })}
      action={
        <Button loading={loading} onClick={onForce}>
          {t("diff.tooLarge.load")}
        </Button>
      }
    >
      {t("diff.tooLarge.body")}
    </Notice>
  );
}

// ---------------------------------------------------------------------------
// Loading and errors
// ---------------------------------------------------------------------------

const skeletonWidths = ["w-2/5", "w-3/5", "w-1/3", "w-1/2", "w-2/3", "w-1/4", "w-3/5", "w-2/5", "w-1/2", "w-1/3", "w-3/4", "w-2/5", "w-1/4", "w-1/2"];

/** Skeleton rows in the shape of a diff. */
export function DiffSkeleton() {
  return (
    <div role="status" aria-label={t("diff.loading")} data-diff-loading="" className="h-full overflow-hidden bg-surface-sunken">
      <div className="h-control-lg border-b border-border bg-surface" />
      <div className="gc-diff-skeleton flex flex-col gap-2 px-3 py-3">
        {skeletonWidths.map((width, index) => (
          <div key={index} className="flex items-center gap-3">
            <span className="h-2.5 w-8 shrink-0 rounded-sm bg-surface-raised" />
            <span className="h-2.5 w-8 shrink-0 rounded-sm bg-surface-raised" />
            <span className={cn("h-2.5 rounded-sm bg-surface-raised", width)} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function DiffError({ error, path, retrying, onRetry, onClose }: { error: CoreError; path: string; retrying: boolean; onRetry: () => void; onClose: () => void }) {
  if (error.code === "not_found" || error.code === "path_not_found") {
    return (
      <Notice
        id="gone"
        icon={<FileQuestion className="size-8" aria-hidden />}
        title={t("diff.error.goneTitle")}
        action={
          <>
            <Button loading={retrying} icon={<RefreshCw className="size-icon" aria-hidden />} onClick={onRetry}>
              {t("diff.error.retry")}
            </Button>
            <Button variant="ghost" onClick={onClose}>
              {t("diff.error.backToGraph")}
            </Button>
          </>
        }
      >
        <p>
          <Trans i18nKey="diff.error.goneBody" values={{ path }} components={{ path: <span className="font-mono text-code break-all" /> }} />
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
      title={t("diff.error.title")}
      action={
        <Button loading={retrying} icon={<RefreshCw className="size-icon" aria-hidden />} onClick={onRetry}>
          {t("diff.error.retry")}
        </Button>
      }
    >
      <p>{text}</p>
      {hint ? <p>{hint}</p> : null}
    </Notice>
  );
}
