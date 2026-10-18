import { describe, expect, it } from "vitest";
import type { AiStatus, ReleaseNotes } from "../../core";
import { toHostRepo } from "../../app/actions/hostTypes";
import { answerPlacement, availabilityOf, availableTargets, doneLine, localDate, rangeLine, targetHint, targetLabel, toggleTarget } from "./model";

const range = (partial: Partial<ReleaseNotes["range"]> = {}): ReleaseNotes["range"] => ({ from: "v1.1.0", fromSha: "a".repeat(40), toSha: "b".repeat(40), commits: 3, included: 3, ...partial });
const notes = (markdown: string, partial: Partial<ReleaseNotes> = {}): ReleaseNotes => ({ range: range(), language: "de", groups: [], markdown, unmentioned: 0, ...partial });
const on: AiStatus = { state: "on", provider: "ollama", model: "qwen3:8b", connected: true, keyHint: null, local: true, price: null, introPending: false, featuresOff: [] };

describe("release notes targets", () => {
  it("a tag offers the changelog, the host release only where the host has releases, and the clipboard", () => {
    expect(availableTargets("tag", true)).toEqual(["changelog", "host_release", "clipboard"]);
    expect(availableTargets("tag", false)).toEqual(["changelog", "clipboard"]);
  });

  it("a commit has no version, so only the clipboard", () => {
    expect(availableTargets("commit", true)).toEqual(["clipboard"]);
  });

  it("the selection keeps the fixed order changelog, release, clipboard", () => {
    const picked = toggleTarget(toggleTarget([], "clipboard", true), "changelog", true);
    expect(picked).toEqual(["changelog", "clipboard"]);
    expect(toggleTarget(picked, "changelog", false)).toEqual(["clipboard"]);
    expect(toggleTarget(picked, "clipboard", true)).toEqual(["changelog", "clipboard"]);
  });

  it("names the host and marks the release as external and irreversible", () => {
    expect(targetLabel("host_release", "GitHub")).toBe("Create release on GitHub");
    expect(targetHint("host_release", "origin")).toBe("External: Pushes the tag to origin first. Leaves this computer and cannot be undone.");
    expect(targetHint("clipboard", "origin")).toBeNull();
  });
});

describe("range and status lines", () => {
  it("counts the commits since the tag", () => {
    expect(rangeLine(range({ commits: 1, included: 1 }))).toBe("1 commit since v1.1.0");
    expect(rangeLine(range({ commits: 312, included: 300 }))).toBe("312 commits since v1.1.0 – only the newest 300 are sent");
    expect(rangeLine(range({ from: null, fromSha: null, commits: 4, included: 4 }))).toBe("4 commits since the first commit");
  });

  it("says what the draft is based on and what was left out", () => {
    expect(doneLine(notes("### Neu\n\n- x", { range: range({ commits: 2, included: 2 }), unmentioned: 1 }))).toBe("Draft from 2 commits since v1.1.0. 1 commit without a visible change is not mentioned.");
    expect(doneLine(notes("### Neu\n\n- x", { range: range({ from: null, fromSha: null, commits: 1, included: 1 }) }))).toBe("Draft from 1 commit since the first commit.");
  });
});

describe("where the answer goes", () => {
  it("an empty field gets the notes, typed text is never replaced unasked", () => {
    expect(answerPlacement("", "", notes("### Neu\n\n- Export"))).toEqual({ kind: "insert", text: "### Neu\n\n- Export" });
    expect(answerPlacement("Mein Text", "Mein Text", notes("### Neu\n\n- Export"))).toEqual({ kind: "choose" });
    expect(answerPlacement("getippt", "", notes("### Neu\n\n- Export"))).toEqual({ kind: "ready" });
  });

  it("no commits: a short sentence instead of text", () => {
    expect(answerPlacement("", "", notes("", { range: range({ commits: 0, included: 0 }) }))).toEqual({ kind: "empty", text: "No commits since v1.1.0 – nothing to write." });
  });
});

describe("availability", () => {
  const github = toHostRepo({ remote: "origin", kind: "github", account: { id: "a1", kind: "github" }, owner: "octo", name: "demo", webUrl: "https://github.com/octo/demo", capabilities: { releases: true } });
  const bitbucket = toHostRepo({ remote: "origin", kind: "bitbucket", account: { id: "a2", kind: "bitbucket" }, owner: "team", name: "demo", webUrl: "https://bitbucket.org/team/demo" });
  const unconnected = toHostRepo({ remote: "origin", kind: "github", account: null, owner: "octo", name: "demo", webUrl: "https://github.com/octo/demo" });

  it("follows the AI state, the function switch and the repository switch", () => {
    expect(availabilityOf(on, false, null).visible).toBe(true);
    expect(availabilityOf({ ...on, state: "off" }, false, null).visible).toBe(false);
    expect(availabilityOf({ ...on, state: "unset" }, false, null).visible).toBe(false);
    expect(availabilityOf({ ...on, featuresOff: ["release_notes"] }, false, null).visible).toBe(false);
    expect(availabilityOf(on, true, null).visible).toBe(false);
    expect(availabilityOf({ ...on, connected: false }, false, null)).toMatchObject({ visible: true, openSetup: true });
  });

  it("offers the host release only with a connected host that has releases", () => {
    expect(availabilityOf(on, false, github)).toMatchObject({ hostReleases: true, hostName: "GitHub", remote: "origin" });
    expect(availabilityOf(on, false, bitbucket).hostReleases).toBe(false);
    expect(availabilityOf(on, false, unconnected).hostReleases).toBe(false);
  });
});

describe("local date", () => {
  it("uses the local calendar day", () => {
    expect(localDate(new Date(2026, 9, 16, 23, 59, 59))).toBe("2026-10-16");
    expect(localDate(new Date(2027, 0, 1, 0, 0, 0))).toBe("2027-01-01");
  });
});
