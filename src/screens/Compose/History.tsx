/**
 * The history preview on top of "Compose commits": HEAD as it is today, then the commits that will
 * be created, in lane colours and with their subjects – updated on every move. A click jumps to
 * the commit, or to its dependency problem when it has one.
 */
import { Fragment } from "react";
import { laneColor } from "../../ui/cn";
import { t } from "../../i18n";
import { commitProblems, type Arrangement, type Units } from "./model";

export function History({ arrangement, units, branch, headSubject, onJump }: { arrangement: Arrangement; units: Units; branch: string; headSubject: string; onJump: (commit: number) => void }) {
  return (
    <nav
      aria-label={t("wip.compose.history")}
      data-compose-history=""
      className="flex shrink-0 items-center overflow-x-auto border-b border-border bg-surface px-3 py-2"
    >
      <span className="mr-3 shrink-0 text-xs text-text-muted">{t("wip.compose.after")}</span>
      <span className="flex shrink-0 items-center gap-2 px-1 py-0.5" title={t("wip.compose.headTip")}>
        <span className="size-2.5 shrink-0 rounded-full border-2 border-text-muted" aria-hidden />
        <span className="max-w-56 truncate text-sm text-text-muted">
          {branch} · {headSubject}
        </span>
      </span>
      {arrangement.commits.map((commit, index) => {
        const broken = commitProblems(arrangement, units, index).length > 0;
        const subject = commit.title.trim() || t("wip.compose.noMessage");
        return (
          <Fragment key={commit.key}>
            <span className="h-0.5 w-5 shrink-0 bg-border" aria-hidden />
            <button
              type="button"
              data-compose-history-commit={String(index)}
              data-broken={broken ? "" : undefined}
              title={subject}
              onClick={() => onJump(index)}
              className="flex shrink-0 items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-surface-raised"
            >
              <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: laneColor(index) }} aria-hidden />
              <span className={commit.title.trim() ? "max-w-56 truncate text-sm text-text" : "max-w-56 truncate text-sm text-text-muted"}>{subject}</span>
              {broken ? <span className="text-xs text-warning">{t("wip.compose.brokenShort")}</span> : null}
            </button>
          </Fragment>
        );
      })}
    </nav>
  );
}
