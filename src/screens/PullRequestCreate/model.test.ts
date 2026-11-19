import { describe, expect, it } from "vitest";
import { t } from "../../i18n";
import { createBlocked, defaultTarget, targetRef } from "./model";

const ref = (name: string, remote: string | null, fullName: string) => ({ name, remote, fullName, sha: fullName });

describe("the ref behind the target branch", () => {
  const remotes = [
    ref("upstream/main", "upstream", "refs/remotes/upstream/main"),
    ref("origin/main", "origin", "refs/remotes/origin/main"),
    ref("origin/release/2.x", "origin", "refs/remotes/origin/release/2.x"),
  ];
  // A local branch that is literally called "origin/main" – its short name collides with the remote branch.
  const locals = [
    ref("main", null, "refs/heads/main"),
    ref("origin/main", null, "refs/heads/origin/main"),
    ref("nur-lokal", null, "refs/heads/nur-lokal"),
  ];

  it("takes the host's remote first, then any remote, then the local branch", () => {
    expect(targetRef(remotes, locals, "origin", "main")?.fullName).toBe("refs/remotes/origin/main");
    expect(targetRef(remotes, locals, "upstream", "main")?.fullName).toBe("refs/remotes/upstream/main");
    expect(targetRef(remotes, locals, "fork", "release/2.x")?.fullName).toBe("refs/remotes/origin/release/2.x");
    expect(targetRef(remotes, locals, "origin", "nur-lokal")?.fullName).toBe("refs/heads/nur-lokal");
    expect(targetRef(remotes, locals, "origin", "gibt-es-nicht")).toBeNull();
  });
});

describe("the target branch before the user picks one", () => {
  it("prefers the host's (last known) default, then main, master, the first", () => {
    expect(defaultTarget(["dev", "main"], "trunk", false), "the host's default even if not fetched").toBe("trunk");
    expect(defaultTarget(["dev", "master", "main"], null, false)).toBe("main");
    expect(defaultTarget(["dev", "master"], null, false)).toBe("master");
    expect(defaultTarget(["dev"], null, false)).toBe("dev");
    expect(defaultTarget([], null, false)).toBeNull();
  });

  it("into the original of a fork only a listed branch counts", () => {
    expect(defaultTarget(["dev", "main"], "trunk", true)).toBe("main");
    expect(defaultTarget(["dev", "trunk"], "trunk", true)).toBe("trunk");
  });
});

describe("why a pull request cannot be created", () => {
  const ok = { source: "feature", target: "main", sameBranch: false, existing: null, ahead: 2, needsPush: false };

  it("checks source, target, same branch, an open pull request and an empty range in this order", () => {
    expect(createBlocked(ok)).toBeNull();
    expect(createBlocked({ ...ok, source: null, target: null })).toBe(t("pullRequest.create.blocked.noSource"));
    expect(createBlocked({ ...ok, target: null })).toBe(t("pullRequest.create.blocked.noTarget"));
    expect(createBlocked({ ...ok, sameBranch: true, existing: { number: 4 } })).toBe(t("pullRequest.create.blocked.same"));
    expect(createBlocked({ ...ok, existing: { number: 4 } })).toBe(
      t("pullRequest.create.blocked.existing", { branch: "feature", number: 4 }),
    );
    expect(createBlocked({ ...ok, ahead: 0 })).toBe(t("pullRequest.create.blocked.nothing", { source: "feature", target: "main" }));
  });

  it("nothing ahead is fine while the branch still has to be pushed, and an unknown count blocks nothing", () => {
    expect(createBlocked({ ...ok, ahead: 0, needsPush: true })).toBeNull();
    expect(createBlocked({ ...ok, ahead: null })).toBeNull();
  });
});
