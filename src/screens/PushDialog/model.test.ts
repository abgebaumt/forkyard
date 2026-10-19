import { describe, expect, it } from "vitest";
import type { PushResult, Ref, RefsSnapshot } from "../../core";
import { t } from "../../i18n";
import { allThrough, atomicByDefault, filterCandidates, pushCandidates, resultLines, toExtras } from "./model";

const ref = (patch: Partial<Ref>): Ref => ({
  name: "main",
  fullName: "refs/heads/main",
  kind: "local",
  sha: "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  isHead: false,
  upstream: null,
  upstreamGone: false,
  pushesToUpstream: true,
  unpublished: null,
  ahead: 0,
  behind: 0,
  remote: null,
  annotation: null,
  isAnnotated: false,
  worktreePath: null,
  ...patch,
});

const refs: RefsSnapshot = {
  head: { kind: "branch", branch: "main", sha: "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  locals: [
    ref({ name: "main", fullName: "refs/heads/main", isHead: true, upstream: "origin/main" }),
    ref({ name: "feature/größe", fullName: "refs/heads/feature/größe", upstream: "origin/feature/groesse", ahead: 2 }),
    ref({ name: "neu", fullName: "refs/heads/neu" }),
  ],
  remotes: [ref({ name: "origin/main", fullName: "refs/remotes/origin/main", kind: "remote", remote: "origin" })],
  tags: [ref({ name: "v1.0", fullName: "refs/tags/v1.0", kind: "tag" })],
};

describe("push dialog with a branch that follows another name", () => {
  // Created from origin/develop on the command line: the upstream is develop, but a push doesn't go there.
  const qa = ref({ name: "qa/blackbox", fullName: "refs/heads/qa/blackbox", upstream: "origin/develop", pushesToUpstream: false, unpublished: 2, ahead: 3 });
  const withQa: RefsSnapshot = { ...refs, locals: [...refs.locals, qa] };

  it("lists it as new with its own commits instead of counting commits to develop", () => {
    const hint = pushCandidates(withQa, "main").find((item) => item.key === "refs/heads/qa/blackbox")!.hint;
    expect(hint).toBe(t("pushMany.candidate.newCount", { count: 2 }));
  });

  it("sends it under its own name, never onto develop", () => {
    expect(toExtras(["refs/heads/qa/blackbox"], withQa, "origin")).toEqual([{ local: "refs/heads/qa/blackbox", remoteName: null, force: false }]);
  });
});

describe("push dialog", () => {
  it("offers the other local branches and all tags", () => {
    const list = pushCandidates(refs, "main");
    expect(list.map((item) => [item.key, item.kind])).toEqual([
      ["refs/heads/feature/größe", "branch"],
      ["refs/heads/neu", "branch"],
      ["refs/tags/v1.0", "tag"],
    ]);
    expect(list[0]!.hint).toBe(t("pushMany.candidate.ahead", { count: 2, upstream: "origin/feature/groesse" }));
    expect(list[1]!.hint).toBe(t("pushMany.candidate.new"));
    expect(filterCandidates(list, "GRÖ").map((item) => item.key)).toEqual(["refs/heads/feature/größe"]);
    expect(filterCandidates(list, " ")).toHaveLength(3);
  });

  it("keeps the upstream name on the remote and is atomic as soon as more than one ref goes", () => {
    expect(toExtras(["refs/heads/feature/größe", "refs/heads/neu", "refs/tags/v1.0"], refs, "origin")).toEqual([
      { local: "refs/heads/feature/größe", remoteName: "feature/groesse", force: false },
      { local: "refs/heads/neu", remoteName: null, force: false },
      { local: "refs/tags/v1.0", remoteName: null, force: false },
    ]);
    expect(toExtras(["refs/heads/feature/größe"], refs, "upstream")[0]!.remoteName).toBeNull();
    expect(atomicByDefault(0)).toBe(false);
    expect(atomicByDefault(1)).toBe(true);
  });

  it("describes the result per ref", () => {
    const result: PushResult = {
      status: "multi",
      remote: "origin",
      atomic: false,
      refs: [
        { local: "refs/heads/main", remoteRef: "refs/heads/main", status: "ok", forced: false, reason: null },
        { local: "refs/heads/neu", remoteRef: "refs/heads/neu", status: "rejected", forced: false, reason: "non-fast-forward" },
        { local: "refs/tags/v1.0", remoteRef: "refs/tags/v1.0", status: "up_to_date", forced: false, reason: null },
      ],
    };
    expect(resultLines(result)).toEqual([
      { ref: "main", status: "ok", text: t("pushMany.result.ok") },
      { ref: "neu", status: "rejected", text: t("pushMany.result.rejected", { reason: "non-fast-forward" }) },
      { ref: "v1.0", status: "up_to_date", text: t("pushMany.result.upToDate") },
    ]);
    expect(allThrough(result)).toBe(false);
    expect(allThrough({ ...result, refs: [result.refs[0]!] })).toBe(true);
    expect(resultLines({ status: "up_to_date" })).toEqual([]);
  });
});
