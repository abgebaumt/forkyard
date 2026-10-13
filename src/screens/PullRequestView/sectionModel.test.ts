import { describe, expect, it } from "vitest";
import type { PrSummary } from "../../app/actions/hostTypes";
import { parentRemote, splitNames, targetBranches } from "../PullRequestCreate/model";
import { checksText, prPhase, reviewLabel } from "./parts";
import { groupPrs, matchesPr } from "./sectionModel";

const pr = (number: number, patch: Partial<PrSummary> = {}): PrSummary => ({
  number,
  title: `Titel ${number}`,
  state: "open",
  isDraft: false,
  author: { login: "jonas", name: "Jonas Albrecht", avatarUrl: null },
  sourceBranch: `thema/${number}`,
  targetBranch: "main",
  updatedAt: null,
  webUrl: null,
  checks: null,
  reviewState: null,
  labels: [],
  isFork: false,
  ...patch,
});

describe("\"Pull Requests\" section", () => {
  const list = [
    pr(1, { author: { login: "Lena", name: null, avatarUrl: null } }),
    pr(2, { reviewState: "review_required" }),
    pr(3, { reviewState: "review_required", isDraft: true }),
    pr(4, { reviewState: "approved" }),
    pr(5, { author: { login: "lena", name: null, avatarUrl: null }, reviewState: "review_required" }),
    pr(6, { state: "merged" }),
  ];

  it("mine, to review, all open", () => {
    const groups = groupPrs(list, "lena");
    expect(groups.mine.map((item) => item.number)).toEqual([1, 5]);
    expect(groups.review.map((item) => item.number)).toEqual([2]);
    expect(groups.all.map((item) => item.number)).toEqual([1, 2, 3, 4, 5]);
  });

  it("without a known own name none is \"mine\"", () => {
    expect(groupPrs(list, null).mine).toEqual([]);
    expect(groupPrs(list, null).review.map((item) => item.number)).toEqual([2, 5]);
  });

  it("the filter matches number, title, author, branches and labels", () => {
    const item = pr(12, { title: "CSV-Export", sourceBranch: "feature/export", labels: ["Daten"] });
    for (const query of ["#12", "12", "csv", "jonas", "albrecht", "feature/", "main", "daten", "  CSV "]) expect(matchesPr(item, query), query).toBe(true);
    expect(matchesPr(item, "regen")).toBe(false);
    expect(matchesPr(item, "")).toBe(true);
  });
});

describe("state, checks and reviews as text", () => {
  it("state", () => {
    expect(prPhase({ state: "open", isDraft: false })).toBe("open");
    expect(prPhase({ state: "open", isDraft: true })).toBe("draft");
    expect(prPhase({ state: "merged", isDraft: true })).toBe("merged");
    expect(prPhase({ state: "closed", isDraft: false })).toBe("closed");
  });

  it("Checks", () => {
    expect(checksText(null)).toBe("No checks");
    expect(checksText("passing", [{ state: "passing" }])).toBe("1 check passed");
    expect(checksText("passing", [{ state: "passing" }, { state: "passing" }, { state: "skipped" }])).toBe("All 3 checks passed");
    expect(checksText("failing", [{ state: "passing" }, { state: "failing" }])).toBe("1 of 2 checks failed");
    expect(checksText("pending", [{ state: "pending" }, { state: "pending" }, { state: "passing" }])).toBe("2 of 3 checks still running");
    expect(checksText("failing")).toBe("Checks failed");
  });

  it("Reviews", () => {
    expect(reviewLabel("approved")).toBe("Approved");
    expect(reviewLabel("changes_requested")).toBe("Changes requested");
    expect(reviewLabel("review_required")).toBe("Review pending");
    expect(reviewLabel(null)).toBeNull();
    expect(reviewLabel("etwas_neues")).toBe("etwas_neues");
  });
});

describe("create pull request", () => {
  it("reviewers and labels from the text field", () => {
    expect(splitNames("anna, @bernd ,, clara\nanna")).toEqual(["anna", "bernd", "clara"]);
    expect(splitNames("  ")).toEqual([]);
  });

  it("target branches: default branch first, origin before other remotes, no duplicates", () => {
    const refs = [
      { name: "upstream/main", remote: "upstream" },
      { name: "upstream/release/1.0", remote: "upstream" },
      { name: "origin/feature/export", remote: "origin" },
      { name: "origin/main", remote: "origin" },
      { name: "origin/HEAD", remote: "origin" },
    ];
    expect(targetBranches(refs, [{ name: "upstream" }, { name: "origin" }], "main")).toEqual(["main", "feature/export", "release/1.0"]);
    expect(targetBranches(refs, [{ name: "origin" }], "develop")[0]).toBe("develop");
    expect(targetBranches([], [], null)).toEqual([]);
    // Only the branches of the remote that belongs to the host – unless nothing has been fetched from it yet.
    expect(targetBranches(refs, [{ name: "upstream" }, { name: "origin" }], null, "upstream")).toEqual(["main", "release/1.0"]);
    expect(targetBranches(refs, [{ name: "origin" }], "main", "hoster")).toEqual(["main", "feature/export", "release/1.0"]);
  });

  it("fork: the remote that points to the original", () => {
    const remotes = [
      { name: "origin", fetchUrl: "https://github.com/lena/messnetz.git" },
      { name: "upstream", fetchUrl: "git@github.com:Schule/Messnetz.git" },
      { name: "spiegel", fetchUrl: "https://git.example/andere/messnetz" },
    ];
    expect(parentRemote(remotes, { owner: "schule", name: "messnetz" }, "origin")).toBe("upstream");
    expect(parentRemote(remotes, { owner: "lena", name: "messnetz" }, "origin")).toBeNull();
    expect(parentRemote(remotes, { owner: "niemand", name: "nichts" }, "origin")).toBeNull();
    expect(parentRemote(remotes, null, "origin")).toBeNull();
  });
});
