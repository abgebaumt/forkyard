/** Bar above the graph while a bisect runs: progress, Good / Bad / Skip, End; afterwards the result. */
import type { Id, Sha } from "../../core";
import { shortSha } from "../../app/format";
import { useBisectStatus } from "../../app/queries";
import { useAppStore, useBusy } from "../../app/store";
import { Button } from "../../ui/Button";
import { t } from "../../i18n";
import { bisectBusyKey, endBisect, markBisect } from "./actions";
import { bisectBar, type BisectBarState } from "./model";

function barText(bar: BisectBarState): string {
  switch (bar.kind) {
    case "running":
      return t("bisect.bar.step", { step: bar.step, total: bar.total, sha: bar.current ? shortSha(bar.current) : "–" });
    case "waiting":
      return bar.needs === "good" ? t("bisect.bar.waitingGood") : bar.needs === "bad" ? t("bisect.bar.waitingBad") : t("bisect.bar.waitingBoth");
    case "found":
      return t("bisect.bar.found", { sha: shortSha(bar.sha) });
    case "only_skipped":
      return t("bisect.bar.onlySkipped");
    case "off":
      return "";
  }
}

export function BisectBar({ repoId, tabId }: { repoId: Id; tabId: Id }) {
  const { data: status } = useBisectStatus(repoId);
  const busy = useBusy(bisectBusyKey(repoId));
  const bar = bisectBar(status);
  if (bar.kind === "off") return null;
  const marking = bar.kind === "running" || bar.kind === "waiting";
  const showResult = (sha: Sha) => {
    const store = useAppStore.getState();
    store.revealCommit(tabId, sha);
    store.setRightPanel(tabId, "details");
  };
  return (
    <div role="status" data-graph-bisect={bar.kind} className="flex min-h-control-md shrink-0 items-center gap-2 border-b border-border bg-surface pr-1 pl-2 text-sm">
      <p className="min-w-0 flex-1 truncate">
        <span className="font-medium">{t("bisect.bar.title")}</span>
        <span className="text-text-muted"> · {barText(bar)}</span>
      </p>
      {marking ? (
        <>
          <Button size="sm" variant="ghost" disabled={busy} data-bisect-verdict="good" onClick={() => void markBisect(repoId, "good", tabId)}>
            {t("bisect.bar.good")}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} data-bisect-verdict="bad" onClick={() => void markBisect(repoId, "bad", tabId)}>
            {t("bisect.bar.bad")}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} data-bisect-verdict="skip" onClick={() => void markBisect(repoId, "skip", tabId)}>
            {t("bisect.bar.skip")}
          </Button>
        </>
      ) : null}
      {bar.kind === "found" ? (
        <Button size="sm" variant="ghost" onClick={() => showResult(bar.sha)}>
          {t("bisect.bar.showResult")}
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void endBisect(repoId, tabId)}>
        {t("bisect.bar.end")}
      </Button>
    </div>
  );
}
