import { describe, expect, it } from "vitest";
import { remoteOfUpstream } from "./fastForward";

describe("remoteOfUpstream", () => {
  it("takes the remote the upstream name starts with", () => {
    expect(remoteOfUpstream("origin/main", ["origin", "upstream"])).toBe("origin");
    expect(remoteOfUpstream("upstream/feature/x", ["origin", "upstream"])).toBe("upstream");
  });

  it("prefers the longest matching remote name (remote names may contain a slash)", () => {
    expect(remoteOfUpstream("team/a/main", ["team", "team/a"])).toBe("team/a");
  });

  it("is null when no remote matches", () => {
    expect(remoteOfUpstream("gone/main", ["origin"])).toBeNull();
  });
});
