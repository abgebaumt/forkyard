import { describe, expect, it } from "vitest";
import { baseName, hostKindOf, refNameIssue, splitPath } from "./paths";

describe("paths", () => {
  it("splits repository paths at the last slash only", () => {
    expect(splitPath("a/b/c.txt")).toEqual({ dir: "a/b/", name: "c.txt" });
    expect(splitPath("top.txt")).toEqual({ dir: "", name: "top.txt" });
    expect(splitPath("dir\\file")).toEqual({ dir: "", name: "dir\\file" });
    expect(baseName("a/b/c.txt")).toBe("c.txt");
    expect(baseName("c.txt")).toBe("c.txt");
  });

  it("names the first ref-name rule that is broken", () => {
    expect(refNameIssue("feature/login")).toBeNull();
    expect(refNameIssue("")).toBeNull();
    expect(refNameIssue("a b")?.issue).toBe("space");
    expect(refNameIssue("a:b")).toEqual({ issue: "char", char: ":" });
    expect(refNameIssue("a\u0001b")?.issue).toBe("char");
    expect(refNameIssue("a..b")?.issue).toBe("doubleDot");
    expect(refNameIssue("a@{1}")?.issue).toBe("atBrace");
    expect(refNameIssue("-x")?.issue).toBe("leadingDash");
    expect(refNameIssue("a//b")?.issue).toBe("slashes");
    expect(refNameIssue("a/")?.issue).toBe("slashes");
    expect(refNameIssue("a.")?.issue).toBe("trailingDot");
    expect(refNameIssue("a/.b")?.issue).toBe("dotOrLock");
    expect(refNameIssue(".a")?.issue).toBe("dotOrLock");
    expect(refNameIssue("a.lock")?.issue).toBe("dotOrLock");
    expect(refNameIssue("HEAD")?.issue).toBe("reserved");
  });

  it("detects hosters by any label, including self-hosted ones", () => {
    expect(hostKindOf("github.com")).toBe("github");
    expect(hostKindOf("github.corp.example")).toBe("github");
    expect(hostKindOf("gitlab.example.org")).toBe("gitlab");
    expect(hostKindOf("bitbucket.org")).toBe("bitbucket");
    expect(hostKindOf("dev.azure.com")).toBe("azure");
    expect(hostKindOf("ssh.dev.azure.com")).toBe("azure");
    expect(hostKindOf("example.com")).toBe("other");
  });
});
