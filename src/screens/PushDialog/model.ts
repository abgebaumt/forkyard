/** Pure helpers of the push dialog: which refs can come along, what goes to the core, result lines. No React, no core calls. */
import type { PushExtra, PushRefStatus, PushResult, RefsSnapshot } from "../../core";
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
      hint: ref.upstream ? (ref.ahead > 0 ? t("pushMany.candidate.ahead", { count: ref.ahead, upstream: ref.upstream }) : ref.upstream) : t("pushMany.candidate.new"),
    }));
  const tags: PushCandidate[] = refs.tags.map((ref) => ({ key: ref.fullName, label: ref.name, kind: "tag", hint: null }));
  return [...branches, ...tags];
}

export function filterCandidates(list: PushCandidate[], query: string): PushCandidate[] {
  const needle = query.trim().toLowerCase();
  return needle ? list.filter((item) => item.label.toLowerCase().includes(needle)) : list;
}

/** `extra` for the core. A branch keeps its upstream's name if that upstream is on `remote`. */
export function toExtras(selected: string[], refs: RefsSnapshot, remote: string): PushExtra[] {
  const prefix = `${remote}/`;
  return selected.map((key) => {
    const local = refs.locals.find((ref) => ref.fullName === key);
    const upstream = local?.upstream ?? null;
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
