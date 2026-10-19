/** Pure helpers of the push dialog: which refs can come along, what goes to the core, result lines. No React, no core calls. */
import type { PushExtra, PushRefStatus, PushResult, Ref, RefsSnapshot } from "../../core";
import { refPublishState } from "../../app/publishState";
import { t } from "../../i18n";

export interface PushCandidate {
  /** Full ref, e.g. `refs/heads/feature` – what the core gets as `extra[].local`. */
  key: string;
  label: string;
  kind: "branch" | "tag";
  hint: string | null;
}

/** All local branches except the primary one, then all tags. */
export function pushCandidates(refs: RefsSnapshot, primary: string): PushCandidate[] {
  const branches: PushCandidate[] = refs.locals
    .filter((ref) => ref.name !== primary)
    .map((ref) => ({
      key: ref.fullName,
      label: ref.name,
      kind: "branch",
      hint: candidateHint(ref),
    }));
  const tags: PushCandidate[] = refs.tags.map((ref) => ({ key: ref.fullName, label: ref.name, kind: "tag", hint: null }));
  return [...branches, ...tags];
}

function candidateHint(ref: Ref): string {
  const state = refPublishState(ref);
  if (state.kind === "published") return state.ahead > 0 ? t("pushMany.candidate.ahead", { count: state.ahead, upstream: state.upstream }) : state.upstream;
  // Not on the remote yet (no upstream, gone, or an upstream of another name): a new branch there.
  return state.unpublished ? t("pushMany.candidate.newCount", { count: state.unpublished }) : t("pushMany.candidate.new");

}

export function filterCandidates(list: PushCandidate[], query: string): PushCandidate[] {
  const needle = query.trim().toLowerCase();
  return needle ? list.filter((item) => item.label.toLowerCase().includes(needle)) : list;
}

/**
 * `extra` for the core. A branch keeps its upstream's name if that upstream is on `remote` – but
 * only if a plain push goes there: one that follows a branch of another name (created from
 * `origin/develop`) goes under its own name, never onto `develop`.
 */
export function toExtras(selected: string[], refs: RefsSnapshot, remote: string): PushExtra[] {
  const prefix = `${remote}/`;
  return selected.map((key) => {
    const local = refs.locals.find((ref) => ref.fullName === key);
    const upstream = local?.pushesToUpstream ? local.upstream : null;

    return { local: key, remoteName: upstream?.startsWith(prefix) ? upstream.slice(prefix.length) : null, force: false };
  });
}

/** “All or nothing” is on as soon as more than one ref is involved. */
export function atomicByDefault(extraCount: number): boolean {
  return extraCount > 0;
}

export interface ResultLine {
  ref: string;
  status: PushRefStatus;
  text: string;
}

export function resultLines(result: PushResult): ResultLine[] {
  if (result.status !== "multi") return [];
  return result.refs.map((item) => ({
    ref: item.remoteRef.replace(/^refs\/(heads|tags)\//, ""),
    status: item.status,
    text:
      item.status === "ok"
        ? item.forced
          ? t("pushMany.result.forced")
          : t("pushMany.result.ok")
        : item.status === "up_to_date"
          ? t("pushMany.result.upToDate")
          : t("pushMany.result.rejected", { reason: item.reason ?? "" }),
  }));
}

/** Nothing was rejected. */
export function allThrough(result: PushResult): boolean {
  return result.status === "multi" && result.refs.every((item) => item.status !== "rejected");
}
