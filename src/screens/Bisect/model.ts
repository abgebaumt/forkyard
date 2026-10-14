/** Pure helpers of the bisect bar and the marks in the graph. */
import type { BisectStatus, Sha } from "../../core";

export type BisectMark = "good" | "bad" | "skip";

export type BisectBarState =
  | { kind: "off" }
  | { kind: "waiting"; needs: "bad" | "good" | "both" }
  | { kind: "running"; step: number; total: number; current: Sha | null }
  | { kind: "found"; sha: Sha }
  | { kind: "only_skipped" };

/** What the bar above the graph shows: "Step n of ~m", the result, or what is still missing. */
export function bisectBar(status: BisectStatus | undefined): BisectBarState {
  if (!status?.active) return { kind: "off" };
  if (status.result) return { kind: "found", sha: status.result };
  if (status.onlySkippedLeft) return { kind: "only_skipped" };
  if (!status.bad || status.good.length === 0) {
    return { kind: "waiting", needs: !status.bad && status.good.length === 0 ? "both" : !status.bad ? "bad" : "good" };
  }
  const step = status.stepsDone + 1;
  return { kind: "running", step, total: step + (status.remainingSteps ?? 0), current: status.current };
}

/** Mark per commit for the graph rows; empty without a bisect. */
export function bisectMarks(status: BisectStatus | undefined): ReadonlyMap<Sha, BisectMark> {
  const marks = new Map<Sha, BisectMark>();
  if (!status?.active) return marks;
  for (const sha of status.good) marks.set(sha, "good");
  for (const sha of status.skipped) marks.set(sha, "skip");
  if (status.bad) marks.set(status.bad, "bad");
  return marks;
}
