import { describe, expect, it } from "vitest";
import type { Ref, UpstreamState } from "../core";
import { t } from "../i18n";
import { pushState } from "./actions/pullrequests";
import { pushHint } from "./menus/entries";
import { nothingToPush, outgoing, publishRemote, publishTarget, refPublishState, statusPublishState, upstreamPublishState } from "./publishState";
import { refDetail } from "../screens/CommandPalette/sources";
import { rowSync } from "../screens/LeftPanel/RefRow";

const local = (patch: Partial<Ref>): Ref => ({
  name: "qa/blackbox",
  fullName: "refs/heads/qa/blackbox",
  kind: "local",
  sha: "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  isHead: true,
  upstream: "origin/develop",
  upstreamGone: false,
  pushesToUpstream: false,
  unpublished: 1,
  ahead: 0,
  behind: 0,
  remote: null,
  annotation: null,
  isAnnotated: false,
  worktreePath: null,
  ...patch,
});
/** A fresh local branch: no upstream, `count` commits on no remote branch. */
const fresh = (count: number) => local({ name: "feature/neu", fullName: "refs/heads/feature/neu", upstream: null, pushesToUpstream: false, unpublished: count });
/** Published under its own name. */
const published = (patch: Partial<Ref> = {}) => local({ upstream: "origin/qa/blackbox", pushesToUpstream: true, unpublished: null, ...patch });

const upstream = (patch: Partial<UpstreamState>): UpstreamState => ({ name: "origin/develop", ahead: 0, behind: 0, gone: false, pushesToUpstream: false, ...patch });

describe("publish state", () => {
  it("a branch following an upstream of another name is to push, even at ↑0 against develop", () => {
    // Created from origin/develop: level with develop, its own commit on no remote branch.
    const state = statusPublishState({ upstream: upstream({ ahead: 0, behind: 3 }), unpublished: 1 });
    expect(state).toEqual({ kind: "elsewhere", upstream: "origin/develop", behind: 3, unpublished: 1 });
    expect(nothingToPush(state)).toBe(false);
    expect(outgoing(state)).toEqual({ count: 1, isNew: true });
    expect(refPublishState(local({ ahead: 4, behind: 1 }))).toEqual({ kind: "elsewhere", upstream: "origin/develop", behind: 1, unpublished: 1 });
  });

  it("fresh branches with and without own commits, gone upstreams", () => {
    expect(outgoing(refPublishState(fresh(3)))).toEqual({ count: 3, isNew: true });
    // No own commits: still to push – the branch itself is missing on the remote.
    expect(outgoing(refPublishState(fresh(0)))).toEqual({ count: 0, isNew: true });
    expect(nothingToPush(refPublishState(fresh(0)))).toBe(false);
    const gone = refPublishState(local({ upstream: "origin/kurz", upstreamGone: true, pushesToUpstream: true, unpublished: 2 }));
    expect(gone).toEqual({ kind: "gone", upstream: "origin/kurz", unpublished: 2 });
    expect(outgoing(gone)).toEqual({ count: 2, isNew: true });
    // Without a remote the core counts nothing.
    expect(outgoing(upstreamPublishState(null, null))).toBeNull();
  });

  it("published branches", () => {
    const same = upstreamPublishState(upstream({ name: "origin/main", pushesToUpstream: true, ahead: 2, behind: 1 }));
    expect(same).toEqual({ kind: "published", upstream: "origin/main", ahead: 2, behind: 1 });
    expect(outgoing(same)).toEqual({ count: 2, isNew: false });
    expect(nothingToPush(upstreamPublishState(upstream({ name: "origin/main", pushesToUpstream: true })))).toBe(true);
    expect(outgoing(upstreamPublishState(upstream({ name: "origin/main", pushesToUpstream: true })))).toBeNull();
    // Pushed under another name by the user: Forkyard's marker makes it the push destination.
    expect(refPublishState(published({ upstream: "origin/qa-remote", ahead: 1 }))).toEqual({ kind: "published", upstream: "origin/qa-remote", ahead: 1, behind: 0 });
  });

  it("names the remote and what a push creates there", () => {
    expect(publishRemote("team/fork/develop", ["origin", "team/fork"])).toBe("team/fork");
    expect(publishRemote(null, ["upstream", "origin"])).toBe("origin");
    expect(publishRemote(null, ["upstream"])).toBe("upstream");
    expect(publishRemote(null, [])).toBeNull();
    expect(publishTarget(refPublishState(fresh(2)), "feature/neu", ["origin"])).toBe("origin/feature/neu");
    expect(publishTarget(refPublishState(local({})), "qa/blackbox", ["origin"])).toBe("origin/qa/blackbox");
    expect(publishTarget(refPublishState(local({ upstream: "origin/kurz", upstreamGone: true, pushesToUpstream: true })), "kurz", ["origin"])).toBe("origin/kurz");
  });

  it("menu, pull request screen, palette and branch list show it as to push", () => {
    expect(pushHint(local({}), ["origin"])).toBe(t("menus.branch.createsRemote", { target: "origin/qa/blackbox" }));
    expect(pushHint(fresh(0), ["origin"])).toBe(t("menus.branch.createsRemote", { target: "origin/feature/neu" }));

    expect(pushState(local({}))).toEqual({ state: "no_upstream" });
    expect(pushState(published())).toEqual({ state: "pushed", upstream: "origin/qa/blackbox" });

    expect(refDetail(local({ behind: 2 }))).toBe(`↑1 · ${t("palette.ref.notOnRemote")} · ${t("palette.ref.followsOther", { upstream: "origin/develop" })} · ↓2`);
    expect(refDetail(fresh(0))).toBe(`↑0 · ${t("palette.ref.notOnRemote")}`);
    expect(refDetail(published({ ahead: 1 }))).toBe(`${t("palette.ref.tracks", { upstream: "origin/qa/blackbox" })} · ↑1 ↓0`);

    expect(rowSync(local({ ahead: 5, behind: 2, unpublished: 1 }))).toEqual({
      ahead: 1,
      behind: 2,
      outgoing: true,
      tip: `${t("sidebar.sync.unpublished", { count: 1 })}, ${t("sidebar.sync.followsOther", { upstream: "origin/develop" })}, ${t("sidebar.sync.behind", { count: 2 })}`,
    });
    expect(rowSync(fresh(0))).toEqual({ ahead: 0, behind: 0, outgoing: true, tip: t("sidebar.sync.unpublishedNone") });
    expect(rowSync(fresh(3)).ahead).toBe(3);
    expect(rowSync(published({ ahead: 1 }))).toMatchObject({ ahead: 1, outgoing: false });
  });
});
