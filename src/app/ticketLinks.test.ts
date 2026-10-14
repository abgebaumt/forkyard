import { describe, expect, it } from "vitest";
import type { LinkRule } from "../core";
import { compileRules, expandUrl, hasNestedRepetition, linkify, MAX_LINKED_CHARS, newRuleId, splitKeys, tryRule } from "./ticketLinks";

const rule = (id: string, pattern: string, url: string, source: LinkRule["source"] = "custom"): LinkRule => ({ id, source, pattern, url });

describe("ticket links", () => {
  it("links every match and keeps the text around it", () => {
    const rules = compileRules([rule("jira", String.raw`\b(?:PROJ)-\d+\b`, "https://jira.example/browse/$0")]);
    expect(linkify("Fix PROJ-12 and PROJ-7.", rules)).toEqual([
      { kind: "text", text: "Fix " },
      { kind: "link", text: "PROJ-12", url: "https://jira.example/browse/PROJ-12", ruleId: "jira" },
      { kind: "text", text: " and " },
      { kind: "link", text: "PROJ-7", url: "https://jira.example/browse/PROJ-7", ruleId: "jira" },
      { kind: "text", text: "." },
    ]);
  });

  it("the earlier rule wins at the same place; overlaps are skipped", () => {
    const rules = compileRules([
      rule("preset:redmine:0", String.raw`#(\d+)\b`, "https://redmine.example/issues/$1", "preset"),
      rule("host:issue", String.raw`#(\d+)\b`, "https://github.com/o/r/issues/$1", "host"),
      rule("custom:long", String.raw`5 fix`, "https://x.example/$0"),
    ]);
    expect(linkify("#5 fix", rules)).toEqual([
      { kind: "link", text: "#5", url: "https://redmine.example/issues/5", ruleId: "preset:redmine:0" },
      { kind: "text", text: " fix" },
    ]);
  });

  it("encodes inserted values and drops addresses that are not http(s)", () => {
    const match = /T-(.+)/.exec("T-a b&c")!;
    expect(expandUrl("https://t.example/q?id=$1", match)).toBe("https://t.example/q?id=a%20b%26c");
    expect(expandUrl("javascript:$0", match)).toBeNull();
    expect(expandUrl("https://t.example/$2", match)).toBe("https://t.example/");
  });

  it("skips patterns the engine cannot compile, handles empty text and long texts", () => {
    const rules = compileRules([rule("bad", "(", "https://x.example/$0"), rule("ok", String.raw`A-\d+`, "https://x.example/$0")]);
    expect(rules.map((compiled) => compiled.rule.id)).toEqual(["ok"]);
    expect(linkify("", rules)).toEqual([]);
    expect(linkify("no tickets", rules)).toEqual([{ kind: "text", text: "no tickets" }]);
    expect(linkify("A-1", [])).toEqual([{ kind: "text", text: "A-1" }]);
    const long = "x".repeat(MAX_LINKED_CHARS) + " A-1";
    expect(linkify(long, rules)).toEqual([{ kind: "text", text: long }]);
  });

  it("finds nested repetition like the core", () => {
    for (const pattern of ["(a+)+", String.raw`(?:\d*)*x`, "((a)+)+", "(a{2})+"]) expect(hasNestedRepetition(pattern), pattern).toBe(true);
    for (const pattern of ["(a+)?", "a+b+", "(?:ab)+", "[(+]+", String.raw`\(a+\)+`, String.raw`#(\d+)\b`]) expect(hasNestedRepetition(pattern), pattern).toBe(false);
    // The rest of the core's scan (pattern.rs): alternatives in repeated groups, groups of varying
    // width and repetitions in a row that can share characters.
    const slow = [
      "(a|a)+$",
      String.raw`(?:x|\w)+!`,
      "((a|b)c)+",
      String.raw`\w*\w*!`,
      String.raw`\w+\w+!`,
      String.raw`\w+a\w+!`,
      String.raw`\w+\w{1,50}-`,
      "(?:aa?)+$",
      String.raw`(?:\w\w?)+!`,
      String.raw`(?:\w?){30}!`,
      String.raw`\w?\w?\w?!`,
      String.raw`\w+\w?\w?!`,
      String.raw`\w+\w?-`,
      String.raw`\w{1,2}\w{1,2}\w{1,2}!`,
    ];
    for (const pattern of slow) expect(hasNestedRepetition(pattern), pattern).toBe(true);
    const fine = [
      "a+b+",
      String.raw`[A-Z]+-\d+`,
      String.raw`[A-Z]+-?\d+`,
      "(?:a|b)?c+",
      String.raw`(?:fix(?:es)?|close[sd]?) #(\d+)`,
      "(?:a+)?b",
      String.raw`\b[A-Z][A-Z0-9]+-\d+\b`,
      String.raw`\b(?:ABC|DEF)-(\d{1,6})\b`,
      String.raw`[\w.\-]+@\{(\d+)\}`,
      String.raw`\w+\w{3}-\w+`,
      String.raw`https?://(\S+)`,
    ];
    for (const pattern of fine) expect(hasNestedRepetition(pattern), pattern).toBe(false);
  });

  it("tries a rule for the test field", () => {
    expect(tryRule("(", "https://x.example/$0", "x")).toEqual({ kind: "invalid" });
    expect(tryRule("(a+)+", "https://x.example/$0", "aaa")).toEqual({ kind: "nested" });
    expect(tryRule(String.raw`OPS-(\d+)`, " https://ops.example/$1 ", "see OPS-4, OPS-5")).toEqual({
      kind: "ok",
      links: [
        { text: "OPS-4", url: "https://ops.example/4" },
        { text: "OPS-5", url: "https://ops.example/5" },
      ],
    });
    expect(tryRule(String.raw`OPS-(\d+)`, "ops.example/$1", "OPS-4")).toEqual({ kind: "ok", links: [{ text: "OPS-4", url: null }] });
  });

  it("splits project keys and finds a free rule ID", () => {
    expect(splitKeys(" abc, OPS;ops  x1 ")).toEqual(["ABC", "OPS", "X1"]);
    expect(newRuleId([])).toBe("rule-1");
    expect(newRuleId([{ id: "rule-1", pattern: "", url: "" }, { id: "rule-3", pattern: "", url: "" }])).toBe("rule-2");
  });
});
