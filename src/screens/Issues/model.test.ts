import { describe, expect, it } from "vitest";
import type { IssueSummary } from "../../core";
import { checkIssueTitle, isAssignedTo, issueBranchName, localizeTimes, matchesIssue, retryTime, slugify } from "./model";

describe("branch name from an issue", () => {
  it("number, then the title in lower case with hyphens", () => {
    expect(issueBranchName({ number: 412, title: "Regenmesser neu eichen" })).toBe("412-regenmesser-neu-eichen");
  });

  it("spells out umlauts and drops other accents", () => {
    expect(slugify("Größe der Übersicht für Café Señor ändern")).toBe("groesse-der-uebersicht-fuer-cafe-senor-aendern");
  });

  it("removes punctuation, slashes and doubled separators – also at the edges", () => {
    expect(slugify("  [Bug]: Absturz bei `git pull` / Windows 11!!  ")).toBe("bug-absturz-bei-git-pull-windows-11");
    expect(slugify("feature/neu..lock~^:?*")).toBe("feature-neu-lock");
  });

  it("shortens long titles at a word boundary", () => {
    const name = issueBranchName({
      number: 7,
      title: "Auswertung der Messreihen aller Stationen für das erste Quartal mit Korrekturfaktoren",
    });
    expect(name).toBe("7-auswertung-der-messreihen-aller-stationen-fuer");
    expect(name.length).toBeLessThanOrEqual(2 + 48);
    expect(name.endsWith("-")).toBe(false);
  });

  it("cuts a single overlong word hard", () => {
    expect(slugify("a".repeat(80))).toBe("a".repeat(48));
  });

  it("without a usable title the number remains", () => {
    expect(issueBranchName({ number: 3, title: "🎉🎉" })).toBe("issue-3");
    expect(issueBranchName({ number: 3, title: "" })).toBe("issue-3");
  });
});

describe("filtering issues", () => {
  const issue: IssueSummary = {
    number: 12,
    key: "#12",
    title: "Anmeldung schlägt fehl",
    state: "open",
    author: { login: "lena", name: "Lena Hartmann", avatarUrl: null },
    assignees: [
      { login: "Jonas", name: null, avatarUrl: null },
      { login: "mira", name: null, avatarUrl: null },
    ],
    labels: [
      { name: "bug", color: "#d73a4a" },
      { name: "hilfe gesucht", color: null },
    ],
    updatedAt: "2026-10-01T10:00:00Z",
    webUrl: "https://git.example/o/r/issues/12",
  };

  it('"Assigned to me" compares the login case-insensitively', () => {
    expect(isAssignedTo(issue, "jonas")).toBe(true);
    expect(isAssignedTo(issue, "MIRA")).toBe(true);
    expect(isAssignedTo(issue, "lena")).toBe(false);
    expect(isAssignedTo(issue, null)).toBe(false);
  });

  it("the filter matches title, number and labels", () => {
    expect(matchesIssue(issue, "anmeld")).toBe(true);
    expect(matchesIssue(issue, "#12")).toBe(true);
    expect(matchesIssue(issue, "12")).toBe(true);
    expect(matchesIssue(issue, "BUG")).toBe(true);
    expect(matchesIssue(issue, "13")).toBe(false);
    expect(matchesIssue(issue, "  ")).toBe(true);
  });

  it("states the time of a rate limit in local time", () => {
    const now = new Date(2026, 9, 11, 12, 0, 0);
    const at = new Date(2026, 9, 11, 14, 32, 5);
    const message = `Das Anfrage-Limit von GitHub ist erreicht. Weiter geht es ab ${at.toISOString()}.`;
    expect(retryTime(message, now)).toBe("02:32 PM");
    expect(localizeTimes(message, now)).toBe("Das Anfrage-Limit von GitHub ist erreicht. Weiter geht es ab 02:32 PM.");
    // On a different day the date is included.
    const tomorrow = new Date(2026, 9, 12, 0, 5, 0);
    expect(retryTime(`ab ${tomorrow.toISOString()}`, now)).toBe("October 12 at 12:05 AM");
    expect(retryTime("Das Kontingent ist aufgebraucht.")).toBeNull();
    expect(localizeTimes("ohne Zeitpunkt")).toBe("ohne Zeitpunkt");
  });
});

describe("new work item", () => {
  it("the title must be one non-empty line of at most 255 characters", () => {
    expect(checkIssueTitle("Anmeldung bricht ab")).toBeNull();
    expect(checkIssueTitle(` ${"x".repeat(255)} `)).toBeNull();
    expect(checkIssueTitle("")).not.toBeNull();
    expect(checkIssueTitle("   ")).not.toBeNull();
    expect(checkIssueTitle("zwei\nZeilen")).not.toBeNull();
    expect(checkIssueTitle("x".repeat(256))).not.toBeNull();
  });
});
