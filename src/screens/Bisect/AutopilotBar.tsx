/** Bar above the graph while the bisect autopilot runs or its result is open (9.1): dot + word, progress, Stop / Keep / Remove. */
import type { Id } from "../../core";
import { shortSha } from "../../app/format";
import { useAiStatus, useBisectAutopilot, useRepoSettings } from "../../app/queries";
import { useAppStore, useBusy } from "../../app/store";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { t } from "../../i18n";
import { autopilotBusyKey, closeAutopilot, stopAutopilot } from "./autopilotActions";
import { autopilotBar, type AutopilotBarState } from "./autopilotModel";

type Shown = Exclude<AutopilotBarState, { kind: "off" }>;

const LOOK: Record<Shown["kind"], { dot: string; word: string }> = {
  preparing: { dot: "bg-accent", word: t("bisect.autopilot.state.running") },
  testing: { dot: "bg-accent", word: t("bisect.autopilot.state.running") },
  found: { dot: "bg-success", word: t("bisect.autopilot.state.done") },
  only_skipped: { dot: "bg-warning", word: t("bisect.autopilot.state.undecided") },
  failed: { dot: "bg-danger", word: t("bisect.autopilot.state.failed") },
};

function barText(bar: Shown): string {
  switch (bar.kind) {
    case "preparing":
      return t("bisect.autopilot.preparing");
    case "testing":
      return t("bisect.autopilot.step", { step: bar.step, total: bar.total, sha: bar.current ? shortSha(bar.current) : "–" });
    case "found":
      return t("bisect.autopilot.found", { sha: shortSha(bar.sha), count: bar.steps });
    case "only_skipped":
      return t("bisect.autopilot.onlySkipped", { count: bar.candidates.length });
    case "failed":
      return bar.message;
  }
}

export function AutopilotBar({ repoId, tabId }: { repoId: Id; tabId: Id }) {
  const { data: run } = useBisectAutopilot(repoId);
  // Loaded here so menus and the palette can decide visibility from the cache.
  useAiStatus();
  useRepoSettings(repoId);
  const busy = useBusy(autopilotBusyKey(repoId));
  const bar = autopilotBar(run);
  if (bar.kind === "off") return null;
  const look = LOOK[bar.kind];
  const timedOut = "timedOut" in bar && bar.timedOut > 0 ? t("bisect.autopilot.timedOut", { count: bar.timedOut }) : null;
  const running = bar.kind === "preparing" || bar.kind === "testing";
  const showResult = (sha: string) => {
    const store = useAppStore.getState();
    store.revealCommit(tabId, sha);
    store.setRightPanel(tabId, "details");
  };
  return (
    <div data-bisect-autopilot={bar.kind} className="flex min-h-control-md shrink-0 items-center gap-2 border-b border-border bg-surface pr-1 pl-2 text-sm">
      <span className={cn("inline-flex size-1.5 shrink-0 rounded-full", look.dot)} aria-hidden />
      <p className="min-w-0 flex-1 truncate" aria-live={bar.kind === "failed" ? "assertive" : "polite"}>
        <span className="font-medium">{t("bisect.autopilot.barTitle")}</span>
        <span className="text-text-muted">
          {" "}
          · {look.word} · {barText(bar)}
          {timedOut ? ` · ${timedOut}` : ""}
        </span>
      </p>
      {running ? (
        <Button size="sm" variant="ghost" data-autopilot-action="stop" onClick={() => void stopAutopilot(repoId)}>
          {t("bisect.autopilot.stop")}
        </Button>
      ) : null}
      {bar.kind === "found" ? (
        <Button size="sm" variant="ghost" data-autopilot-action="show" onClick={() => showResult(bar.sha)}>
          {t("bisect.autopilot.showResult")}
        </Button>
      ) : null}
      {!running ? (
        <>
          <Button size="sm" variant="ghost" disabled={busy} data-autopilot-action="keep" onClick={() => void closeAutopilot(repoId, true)}>
            {t("bisect.autopilot.keep")}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} data-autopilot-action="remove" onClick={() => void closeAutopilot(repoId, false)}>
            {t("bisect.autopilot.remove")}
          </Button>
        </>
      ) : null}
    </div>
  );
}
