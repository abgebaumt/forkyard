import { describe, expect, it } from "vitest";
import { targetRef } from "./model";

const ref = (name: string, remote: string | null, fullName: string) => ({ name, remote, fullName, sha: fullName });

describe("the ref behind the target branch", () => {
  const remotes = [ref("upstream/main", "upstream", "refs/remotes/upstream/main"), ref("origin/main", "origin", "refs/remotes/origin/main"), ref("origin/release/2.x", "origin", "refs/remotes/origin/release/2.x")];
  // A local branch that is literally called "origin/main" – its short name collides with the remote branch.
  const locals = [ref("main", null, "refs/heads/main"), ref("origin/main", null, "refs/heads/origin/main"), ref("nur-lokal", null, "refs/heads/nur-lokal")];

  it("takes the host's remote first, then any remote, then the local branch", () => {
    expect(targetRef(remotes, locals, "origin", "main")?.fullName).toBe("refs/remotes/origin/main");
    expect(targetRef(remotes, locals, "upstream", "main")?.fullName).toBe("refs/remotes/upstream/main");
    expect(targetRef(remotes, locals, "fork", "release/2.x")?.fullName).toBe("refs/remotes/origin/release/2.x");
    expect(targetRef(remotes, locals, "origin", "nur-lokal")?.fullName).toBe("refs/heads/nur-lokal");
    expect(targetRef(remotes, locals, "origin", "gibt-es-nicht")).toBeNull();
  });
});
