import { describe, expect, it } from "vitest";
import type { AiPushReview, AiStatus, SecretFinding } from "../../core";
import { t } from "../../i18n";
import {
  acceptedIds,
  findingLocation,
  kindLabel,
  reviewFirst,
  reviewOffered,
  reviewPushLabel,
  reviewRows,
  reviewSummary,
  ruleLabel,
  secretRows,
  secretsNotes,
  secretsTitle,
  stillReported,
} from "./model";

const A = "a".repeat(64);
const finding = (patch: Partial<SecretFinding>): SecretFinding => ({
  id: A,
  path: "einstellungen/dienst.py",
  line: 2,
  commit: "1234567890abcdef1234567890abcdef12345678",
  rule: "known_token",
  excerpt: 'AWS_ZUGANG = "…W3NB"',
  hint: "…W3NB",
  ...patch,
});
const status = (patch: Partial<AiStatus>): AiStatus => ({
  state: "on",
  provider: "ollama",
  model: "qwen3:8b",
  connected: true,
  keyHint: null,
  local: true,
  price: null,
  introPending: false,
  featuresOff: [],
  ...patch,
});
const review = (patch: Partial<AiPushReview>): AiPushReview => ({ findings: [], commits: 2, files: 3, partial: false, ...patch });

describe("secret findings", () => {
  it("are listed by path and line with the masked line and a short commit", () => {
    const rows = secretRows([finding({ id: "b".repeat(64), path: "z/ü datei.env", line: 10 }), finding({ id: "c".repeat(64), path: "-geheim/a.txt", line: 3, rule: "high_entropy" }), finding({})]);
    expect(rows.map((row) => row.location)).toEqual(["-geheim/a.txt:3", "einstellungen/dienst.py:2", "z/ü datei.env:10"]);
    expect(rows[1]).toEqual({ id: A, location: "einstellungen/dienst.py:2", rule: ruleLabel("known_token"), excerpt: 'AWS_ZUGANG = "…W3NB"', commit: "1234567" });
    expect(rows[0]!.rule).toBe(ruleLabel("high_entropy"));
    expect(new Set((["known_token", "private_key", "credential", "url_password", "high_entropy"] as const).map(ruleLabel)).size, "every rule has its own words").toBe(5);
    expect(findingLocation({ path: "a.txt", line: null })).toBe("a.txt");
  });

  it("title, notes and what Push anyway accepts", () => {
    expect(secretsTitle(1)).toBe(t("pushCheck.secrets.title", { count: 1 }));
    expect(secretsTitle(1)).not.toBe(secretsTitle(2));
    expect(secretsNotes({ findings: [finding({})], commits: 3, partial: false })).toEqual([t("pushCheck.secrets.scanned", { count: 3 })]);
    expect(secretsNotes({ findings: [], commits: 1000, partial: true })).toEqual([t("pushCheck.secrets.scanned", { count: 1000 }), t("pushCheck.secrets.partial")]);
    expect(acceptedIds([finding({}), finding({ line: 9 })])).toEqual([A]);
    expect(stillReported([finding({}), finding({ id: "d".repeat(64) })], new Set([A])).map((item) => item.id)).toEqual(["d".repeat(64)]);
  });
});

describe("push review", () => {
  it("lists findings by file and line and names the kind in words", () => {
    const rows = reviewRows(
      review({
        findings: [
          { path: "src/zähler.py", line: 2, kind: "debug_output", note: "Leftover print." },
          { path: "lib/alt.py", line: null, kind: "commented_code", note: "Old block." },
          { path: "src/zähler.py", line: 1, kind: "likely_bug", note: "Off by one." },
        ],
      }),
    );
    expect(rows.map((row) => row.location)).toEqual(["lib/alt.py", "src/zähler.py:1", "src/zähler.py:2"]);
    expect(rows.map((row) => row.kind)).toEqual([kindLabel("commented_code"), kindLabel("likely_bug"), kindLabel("debug_output")]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(3);
    expect(new Set([kindLabel("debug_output"), kindLabel("commented_code"), kindLabel("likely_bug")]).size).toBe(3);
  });

  it("says when nothing stood out and which button pushes", () => {
    expect(reviewSummary(review({}))).toBe(`${t("pushCheck.review.none")} · ${t("pushCheck.review.commits", { count: 2 })}`);
    expect(reviewSummary(review({ commits: 0, files: 0 }))).toBe(t("pushCheck.review.nothing"));
    expect(reviewSummary(review({ findings: [{ path: "a", line: 1, kind: "likely_bug", note: "x" }] }))).toBe(`${t("pushCheck.review.found", { count: 1 })} · ${t("pushCheck.review.commits", { count: 2 })}`);
    expect(reviewPushLabel("done", 0)).toBe(t("pushCheck.review.push"));
    expect(reviewPushLabel("done", 2)).toBe(t("pushCheck.review.pushAnyway"));
    expect(reviewPushLabel("loading", 0)).toBe(t("pushCheck.review.pushAnyway"));
    expect(reviewPushLabel("error", 0)).toBe(t("pushCheck.review.pushAnyway"));
    expect(t("pushCheck.review.push")).not.toBe(t("pushCheck.review.pushAnyway"));
  });

  it("is offered only where the function is visible, and runs first only with the project switch", () => {
    const repo = { aiOff: false, aiReviewBeforePush: true };
    expect(reviewOffered(status({}), repo)).toBe(true);
    expect(reviewOffered(status({ state: "off" }), repo)).toBe(false);
    expect(reviewOffered(status({ state: "unset", connected: false, provider: null }), repo)).toBe(false);
    expect(reviewOffered(status({ featuresOff: ["push_review"] }), repo)).toBe(false);
    expect(reviewOffered(status({}), { ...repo, aiOff: true })).toBe(false);
    expect(reviewOffered(status({ connected: false }), repo), "visible; a click opens the setup").toBe(true);
    expect(reviewFirst(status({}), repo)).toBe(true);
    expect(reviewFirst(status({}), { ...repo, aiReviewBeforePush: false })).toBe(false);
    expect(reviewFirst(status({ state: "off" }), repo)).toBe(false);
    expect(reviewFirst(undefined, repo)).toBe(false);
    expect(reviewFirst(status({}), undefined)).toBe(false);
  });
});
