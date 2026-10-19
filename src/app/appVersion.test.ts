import { describe, expect, it } from "vitest";
import { CHANGELOG_URL, versionLabel } from "./appVersion";

describe("app version in the status bar", () => {
  it("links to the changelog on GitHub", () => {
    expect(CHANGELOG_URL).toBe("https://github.com/abgebaumt/forkyard/blob/main/CHANGELOG.md");
  });

  it("shows the version with a leading v", () => {
    expect(versionLabel("1.2.0")).toBe("v1.2.0");
    expect(versionLabel("1.2.0-beta.1")).toBe("v1.2.0-beta.1");
  });

  it("does not double a v the version already has", () => {
    expect(versionLabel("v1.2.0")).toBe("v1.2.0");
  });
});
