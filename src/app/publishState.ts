/**
 * Is a local branch published where a plain push goes? A branch that is local but not on its remote
 * – no upstream, upstream gone, or an upstream of another name (`git checkout -b qa/x origin/develop`,
 * which a plain push does not reach) – is pending work: the core counts its commits on no remote
 * branch (`unpublished`), and the UI shows them as "to push", 0 included (the branch itself is
 * missing there). Pure, no React, no core calls.
 */
import type { Ref, Status, UpstreamState } from "../core";

export type PublishState =
  /** A plain push goes to the upstream; `ahead` is what it sends. */
  | { kind: "published"; upstream: string; ahead: number; behind: number }
  /** No upstream. `unpublished`: commits on no remote branch (null: no remote, count unknown). */
  | { kind: "none"; unpublished: number | null }
  /** The upstream is set but gone on the remote. */
  | { kind: "gone"; upstream: string; unpublished: number | null }
  /** Follows an upstream of another name that doesn't receive plain pushes. `behind` still counts. */
  | { kind: "elsewhere"; upstream: string; behind: number; unpublished: number | null };

/** For the checked-out branch (`Status.upstream` and `Status.unpublished`). */
export function upstreamPublishState(upstream: UpstreamState | null | undefined, unpublished: number | null = null): PublishState {
  if (!upstream) return { kind: "none", unpublished };
  if (upstream.gone) return { kind: "gone", upstream: upstream.name, unpublished };
  if (!upstream.pushesToUpstream) return { kind: "elsewhere", upstream: upstream.name, behind: upstream.behind, unpublished };
  return { kind: "published", upstream: upstream.name, ahead: upstream.ahead, behind: upstream.behind };
}

/** `upstreamPublishState` for a whole status. */
export function statusPublishState(status: Pick<Status, "upstream" | "unpublished"> | null | undefined): PublishState {
  return upstreamPublishState(status?.upstream, status?.unpublished ?? null);
}

/** For a local branch from the refs list. */
export function refPublishState(ref: Pick<Ref, "upstream" | "upstreamGone" | "pushesToUpstream" | "unpublished" | "ahead" | "behind">): PublishState {
  if (!ref.upstream) return { kind: "none", unpublished: ref.unpublished };
  if (ref.upstreamGone) return { kind: "gone", upstream: ref.upstream, unpublished: ref.unpublished };
  if (!ref.pushesToUpstream) return { kind: "elsewhere", upstream: ref.upstream, behind: ref.behind, unpublished: ref.unpublished };
  return { kind: "published", upstream: ref.upstream, ahead: ref.ahead, behind: ref.behind };
}

/**
 * What a push has to send: the commits ahead of the upstream, or – for a branch not on its remote –
 * its unpublished commits with `isNew` (0 included: the branch itself goes there). `null`: nothing.
 */
export function outgoing(state: PublishState): { count: number; isNew: boolean } | null {
  if (state.kind === "published") return state.ahead > 0 ? { count: state.ahead, isNew: false } : null;
  return state.unpublished === null ? null : { count: state.unpublished, isNew: true };
}

/** "Nothing to push": published and nothing ahead. */
export function nothingToPush(state: PublishState): boolean {
  return state.kind === "published" && state.ahead === 0;
}

/**
 * The remote a branch is (not yet) on: the remote of its upstream (longest matching name, for remote
 * names with a slash), otherwise `origin`, otherwise the first remote. `null` without remotes.
 */
export function publishRemote(upstream: string | null, remotes: readonly string[]): string | null {
  if (upstream) {
    const own = remotes.filter((name) => upstream.startsWith(`${name}/`)).sort((a, b) => b.length - a.length)[0];
    if (own) return own;
  }
  return remotes.includes("origin") ? "origin" : (remotes[0] ?? null);
}

/** Where a push creates the branch: `origin/<name>`, or the gone upstream of the same name. */
export function publishTarget(state: PublishState, branch: string, remotes: readonly string[]): string | null {
  if (state.kind === "gone") return state.upstream;
  if (state.kind === "published") return null;
  const remote = publishRemote(state.kind === "elsewhere" ? state.upstream : null, remotes);
  return remote ? `${remote}/${branch}` : null;
}
