import { describe, expect, it } from "vitest";
import { toIssueDetails, toIssueSummary } from "./api";
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
    const name = issueBranchName({ number: 7, title: "Auswertung der Messreihen aller Stationen für das erste Quartal mit Korrekturfaktoren" });
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

describe("reading and filtering issues", () => {
  const raw = {
    number: 12,
    title: "Anmeldung schlägt fehl",
    state: "open",
    author: { login: "lena", name: "Lena Hartmann", avatarUrl: null },
    assignees: [{ login: "Jonas" }, "mira"],
    labels: [{ name: "bug", color: "d73a4a" }, "hilfe gesucht"],
    updatedAt: "2026-10-01T10:00:00Z",
    webUrl: "https://git.example/o/r/issues/12",
  };

  it("brings the core's answer into a fixed shape", () => {
    const issue = toIssueSummary(raw);
    expect(issue).toMatchObject({ number: 12, key: "#12", state: "open", labels: ["bug", "hilfe gesucht"], commentCount: null });
    expect(issue?.assignees.map((user) => user.login)).toEqual(["Jonas", "mira"]);
    expect(issue?.author).toEqual({ login: "lena", name: "Lena Hartmann", avatarUrl: null });
  });

  it("takes the project-level number for GitLab and only knows open/closed", () => {
    expect(toIssueSummary({ iid: 5, title: "x", state: "closed" })).toMatchObject({ number: 5, key: "#5", state: "closed" });
    expect(toIssueSummary({ number: "9", title: "x", state: "opened" })).toMatchObject({ number: 9, state: "open" });
    expect(toIssueSummary({ title: "ohne Nummer" })).toBeNull();
    expect(toIssueSummary(null)).toBeNull();
  });

  it("details: text and comments, missing fields become empty", () => {
    const details = toIssueDetails({ ...raw, body: "Text", comments: [{ id: 1, author: "mira", body: "Bei mir auch", createdAt: "2026-10-02T08:00:00Z" }, { body: "ohne alles" }] });
    expect(details?.body).toBe("Text");
    expect(details?.commentCount).toBe(2);
    expect(details?.comments.map((comment) => comment.id)).toEqual(["1", "kommentar-1"]);
    expect(toIssueDetails({ number: 1 })).toMatchObject({ body: "", comments: [], title: "" });
  });

  it("\"Assigned to me\" compares the login case-insensitively", () => {
    const issue = toIssueSummary(raw)!;
    expect(isAssignedTo(issue, "jonas")).toBe(true);
    expect(isAssignedTo(issue, "MIRA")).toBe(true);
    expect(isAssignedTo(issue, "lena")).toBe(false);
    expect(isAssignedTo(issue, null)).toBe(false);
  });

  it("the filter matches title, number and labels", () => {
    const issue = toIssueSummary(raw)!;
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
