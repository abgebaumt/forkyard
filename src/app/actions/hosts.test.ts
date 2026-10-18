import { describe, expect, it } from "vitest";
import { CoreError } from "../../core";
import { defaultCapabilities, describeHostError, HOST_KINDS, hostErrorKind, hostKindLabels, localTimes, summarizeChecks, toAccount, toCapabilities, toHostRepo, toPrDetails, toPrSummary, toUser, type HostKind } from "./hostTypes";
import { accountHost, accountState, connectInputs, connectTarget, organizationOf, parseBaseUrl, scrubSecret, tokenPageUrl } from "./hosts";
import { issuesWebUrl } from "../../screens/Issues/actions";
import { mergeBlock, pushState, suggestTitle, titleFromBranch } from "./pullrequests";

const account = { id: "a1", kind: "github", baseUrl: "https://github.com", user: { login: "lena", name: "Lena Hartmann", avatarUrl: null }, tokenHint: "…1234", scopesOk: true, missingScopes: [], lastError: null };

describe("what the core returns, in a fixed shape", () => {
  it("capabilities: from the core, otherwise what the host kind offers", () => {
    const caps = toCapabilities(
      { issues: false, issueCreate: false, draftPrs: true, draftToggle: true, mergeMethods: ["squash", "bogus"], deleteSourceBranch: true, prReopen: false, prReviewers: false, prLabels: true, forkCheckout: false },
      "github",
    );
    expect(caps).toMatchObject({ issues: false, prReopen: false, prReviewers: false, forkCheckout: false, mergeMethods: ["squash"] });
    expect(toCapabilities(undefined, "gitlab")).toEqual(defaultCapabilities.gitlab);
    expect(toCapabilities({ issues: "ja" }, "github").issues).toBe(true);
    expect(defaultCapabilities.github.mergeMethods).toEqual(["merge", "squash", "rebase"]);
    expect(defaultCapabilities.gitlab.mergeMethods).toEqual(["merge", "squash"]);
    const repo = toHostRepo({ kind: "gitlab", account: null, owner: "g", name: "p", capabilities: { mergeMethods: ["merge"] } });
    expect(repo?.capabilities.mergeMethods).toEqual(["merge"]);
    expect(repo?.capabilities.draftToggle).toBe(true);
    expect(toHostRepo({ kind: "github", account: null, owner: "a", name: "b" })?.capabilities).toEqual(defaultCapabilities.github);
  });

  it("user as an object or as a bare name", () => {
    expect(toUser({ login: "lena", name: "Lena Hartmann", avatarUrl: "https://x/y.png" })).toEqual({ login: "lena", name: "Lena Hartmann", avatarUrl: "https://x/y.png" });
    expect(toUser("lena")).toEqual({ login: "lena", name: null, avatarUrl: null });
    expect(toUser({ login: "lena", name: "lena" })?.name).toBeNull();
    expect(toUser(null)).toBeNull();
    expect(toUser({})).toBeNull();
  });

  it("account: unknown hosts are dropped, the token never appears", () => {
    const parsed = toAccount({ ...account, token: "ghp_geheim" });
    expect(parsed).toMatchObject({ id: "a1", kind: "github", tokenHint: "…1234", scopesOk: true });
    expect(JSON.stringify(parsed)).not.toContain("ghp_geheim");
    expect(toAccount({ ...account, kind: "sourcehut" })).toBeNull();
    expect(toAccount({ ...account, kind: "azure" })).toBeNull();
    expect(toAccount({ ...account, missingScopes: ["repo"], scopesOk: false })?.missingScopes).toEqual(["repo"]);
  });

  it("repository host: with account, without account, with an error from the host", () => {
    const repo = toHostRepo({ remote: "origin", kind: "github", account, owner: "schule", name: "messnetz", webUrl: "https://github.com/schule/messnetz", defaultBranch: "main", canPush: true, forkParent: null, error: null });
    expect(repo).toMatchObject({ kind: "github", owner: "schule", defaultBranch: "main", canPush: true, error: null });
    expect(repo?.account?.user?.login).toBe("lena");

    const alone = toHostRepo({ remote: "origin", kind: "gitlab", account: null, owner: "gruppe/unter", name: "projekt", webUrl: "https://gitlab.com/gruppe/unter/projekt", defaultBranch: null, canPush: null, forkParent: null });
    expect(alone?.account).toBeNull();
    expect(alone?.kind).toBe("gitlab");

    const failed = toHostRepo({ kind: "github", account, owner: "a", name: "b", webUrl: "", error: { code: "host_rate_limited", message: "Ab 14:32 Uhr geht es weiter." } });
    expect(failed?.error).toBeInstanceOf(CoreError);
    expect(hostErrorKind(failed?.error)).toBe("rate_limit");

    const fork = toHostRepo({ kind: "github", account, owner: "lena", name: "messnetz", forkParent: { owner: "schule", name: "messnetz", webUrl: "x" } });
    expect(fork?.forkParent).toEqual({ owner: "schule", name: "messnetz", defaultBranch: null });
    expect(toHostRepo(null)).toBeNull();
  });

  it("pull request from the list", () => {
    const pr = toPrSummary({ number: 12, title: "Export", state: "open", isDraft: false, author: { login: "jonas", name: null, avatarUrl: null }, sourceBranch: "feature/export", targetBranch: "main", updatedAt: "2026-03-01T10:00:00Z", webUrl: "https://github.com/a/b/pull/12", checks: "passing", reviewState: "review_required", labels: [{ name: "export", color: "#ff0000" }], isFork: false });
    expect(pr).toMatchObject({ number: 12, state: "open", checks: "passing", reviewState: "review_required", labels: ["export"], isFork: false });
    expect(toPrSummary({ title: "ohne Nummer" })).toBeNull();
    expect(toPrSummary({ number: 3, state: "seltsam" })?.state).toBe("open");
  });

  it("details: checks individually and summarised, head commit", () => {
    const pr = toPrDetails({
      number: 7,
      title: "T",
      state: "open",
      checks: null,
      body: "Text",
      reviewers: [{ user: { login: "aylin" }, state: "approved" }, { user: { login: "mats" }, state: null }],
      comments: [{ id: "c1", author: { login: "jonas" }, body: "Hallo", createdAt: "2026-03-01T10:00:00Z", path: "src/a.py", line: 4 }],
      commits: [{ sha: "aaa", summary: "Erster\nRest", authorName: "Jonas", authoredAt: "2026-03-01T09:00:00Z" }, { sha: "bbb", summary: "Zweiter", authorName: "Jonas", authoredAt: "2026-03-01T09:30:00Z" }],
      mergeable: null,
      checkRuns: [{ name: "build", state: "passing", url: null }, { name: "lint", state: "skipped", url: null }, { name: "test", state: "pending", url: "https://ci/1" }],
      headSha: "bbb",
    });
    expect(pr?.checkRuns.map((check) => check.state)).toEqual(["passing", "skipped", "pending"]);
    expect(pr?.checks).toBe("pending");
    expect(pr?.mergeable).toBeNull();
    expect(pr?.commits[0]?.summary).toBe("Erster");
    expect(pr?.reviewers.map((reviewer) => reviewer.state)).toEqual(["approved", null]);
    expect(pr?.comments[0]).toMatchObject({ path: "src/a.py", line: 4 });
    expect(pr?.headSha).toBe("bbb");
  });

  it("summary of the checks", () => {
    expect(summarizeChecks([])).toBeNull();
    expect(summarizeChecks([{ state: "skipped" }])).toBeNull();
    expect(summarizeChecks([{ state: "passing" }, { state: "skipped" }])).toBe("passing");
    expect(summarizeChecks([{ state: "passing" }, { state: "pending" }])).toBe("pending");
    expect(summarizeChecks([{ state: "pending" }, { state: "failing" }])).toBe("failing");
  });
});

describe("host integration errors", () => {
  const error = (code: string, message = "") => new CoreError({ code: code as CoreError["code"], message, gitOutput: null });

  it("core codes", () => {
    expect(hostErrorKind(error("host_not_connected"))).toBe("not_connected");
    expect(hostErrorKind(error("host_auth_failed"))).toBe("auth");
    expect(hostErrorKind(error("host_auth_failed", "GitHub lehnt den Token ab: Er ist ungültig, abgelaufen oder widerrufen."))).toBe("auth");
    expect(hostErrorKind(error("host_forbidden", "GitHub verweigert den Zugriff: Dem Token fehlt die Berechtigung dafür."))).toBe("permission");
    // The wording no longer decides anything: only the code.
    expect(hostErrorKind(error("host_auth_failed", "… verweigert … fehlt die Berechtigung …"))).toBe("auth");
    expect(hostErrorKind(error("host_forbidden"))).toBe("permission");
    expect(hostErrorKind(error("host_rate_limited"))).toBe("rate_limit");
    expect(hostErrorKind(error("host_not_found"))).toBe("not_found");
    expect(hostErrorKind(error("host_unsupported"))).toBe("unsupported");
    expect(hostErrorKind(error("host_rejected"))).toBe("rejected");
    expect(hostErrorKind(error("offline"))).toBe("offline");
    expect(hostErrorKind(error("dirty_worktree"))).toBe("other");
    expect(hostErrorKind(error("unknown", "Command host_accounts not found"))).toBe("not_built");
  });

  it("the core's message takes precedence (it contains e.g. the time of the limit)", () => {
    const info = describeHostError(error("host_rate_limited", "Das Anfrage-Limit ist erreicht. Ab 14:32 Uhr geht es weiter."));
    expect(info.kind).toBe("rate_limit");
    expect(info.text).toContain("14:32");
    expect(describeHostError(error("host_auth_failed")).text).toMatch(/token/);
  });

  it("the core's timestamps (UTC) are shown in local time", () => {
    const text = localTimes("Weiter geht es ab 2026-10-11T22:52:31.000Z.");
    expect(text).not.toContain("T22:52");
    expect(text).toMatch(/Weiter geht es ab [A-Z][a-z]{2} \d{1,2}, 2026, \d{1,2}:\d{2}\s?[AP]M\./);
    expect(localTimes("ohne Zeit")).toBe("ohne Zeit");
    expect(localTimes("Version 2026-10-11 bleibt")).toBe("Version 2026-10-11 bleibt");
  });
});

describe("accounts", () => {
  it("address of a self-hosted instance", () => {
    expect(parseBaseUrl("git.firma.example")).toEqual({ url: "https://git.firma.example", error: null });
    expect(parseBaseUrl(" https://git.firma.example/ ")).toEqual({ url: "https://git.firma.example", error: null });
    expect(parseBaseUrl("http://127.0.0.1:4010/gitlab/")).toEqual({ url: "http://127.0.0.1:4010/gitlab", error: null });
    expect(parseBaseUrl("http://localhost:4010")).toEqual({ url: "http://localhost:4010", error: null });
    expect(parseBaseUrl("http://git.firma.example").error).toMatch(/Unencrypted/);
    expect(parseBaseUrl("").url).toBeNull();
    expect(parseBaseUrl("ftp://git.firma.example").error).toMatch(/https/);
    expect(parseBaseUrl("https://lena:geheim@git.firma.example").error).toMatch(/password/);
  });

  it("token page at the host", () => {
    expect(tokenPageUrl("github", null)).toBe("https://github.com/settings/tokens");
    expect(tokenPageUrl("gitlab", null)).toBe("https://gitlab.com/-/user_settings/personal_access_tokens");
    expect(tokenPageUrl("gitlab", "https://git.firma.example/")).toBe("https://git.firma.example/-/user_settings/personal_access_tokens");
  });

  it("a token in a message is redacted", () => {
    expect(scrubSecret("401 für ghp_abc123XYZ – abgelehnt (ghp_abc123XYZ)", "ghp_abc123XYZ")).toBe("401 für ••• – abgelehnt (•••)");
    expect(scrubSecret("nichts drin", "ghp_abc123XYZ")).toBe("nichts drin");
    expect(scrubSecret("kurz ab", "ab")).toBe("kurz ab");
  });

  it("state of an account", () => {
    const base = toAccount(account)!;
    expect(accountState(base)).toBe("ok");
    expect(accountState({ ...base, scopesOk: false })).toBe("scopes");
    expect(accountState({ ...base, lastError: "GitHub lehnt den Token ab – er ist abgelaufen oder widerrufen." })).toBe("expired");
    expect(accountState({ ...base, lastError: "Der Hoster ist nicht erreichbar." })).toBe("error");
    expect(accountState({ ...base, user: null })).toBe("expired");
    expect(accountHost(base)).toBe("github.com");
    expect(accountHost({ kind: "gitlab", baseUrl: null })).toBe("gitlab.com");
  });
});

describe("preparing a pull request", () => {
  it("title from the branch name or the single commit", () => {
    expect(titleFromBranch("feature/neue-auswertung")).toBe("Neue auswertung");
    expect(titleFromBranch("thema/regen_summe--monat")).toBe("Regen summe monat");
    expect(titleFromBranch("main")).toBe("Main");
    expect(suggestTitle("feature/export", ["CSV-Export für den Vergleich"])).toBe("CSV-Export für den Vergleich");
    expect(suggestTitle("feature/export", ["Eins", "Zwei"])).toBe("Export");
    expect(suggestTitle("feature/export", null)).toBe("Export");
    expect(suggestTitle("feature/export", [])).toBe("Export");
  });

  it("is the branch on the remote?", () => {
    const ref = { name: "x", upstream: "origin/x", upstreamGone: false, ahead: 0 } as Parameters<typeof pushState>[0];
    expect(pushState(ref)).toEqual({ state: "pushed", upstream: "origin/x" });
    expect(pushState({ ...ref!, ahead: 2 })).toEqual({ state: "ahead", upstream: "origin/x", count: 2 });
    expect(pushState({ ...ref!, upstream: null })).toEqual({ state: "no_upstream" });
    expect(pushState({ ...ref!, upstreamGone: true })).toEqual({ state: "no_upstream" });
    expect(pushState(undefined)).toEqual({ state: "unknown" });
  });

  it("merging is blocked – with a reason", () => {
    const pr = { state: "open", isDraft: false, mergeable: true, mergeBlocked: null, checks: "passing" } as const;
    expect(mergeBlock(pr)).toBeNull();
    expect(mergeBlock({ ...pr, checks: null })).toBeNull();
    expect(mergeBlock({ ...pr, mergeable: false })).toMatch(/conflicts/);
    expect(mergeBlock({ ...pr, mergeable: false, mergeBlocked: "Der Ziel-Branch ist geschützt." })).toBe("Der Ziel-Branch ist geschützt.");
    expect(mergeBlock({ ...pr, checks: "failing" })).toMatch(/failed/);
    expect(mergeBlock({ ...pr, checks: "pending" })).toMatch(/still running/);
    expect(mergeBlock({ ...pr, isDraft: true })).toMatch(/draft/);
    expect(mergeBlock({ ...pr, mergeable: null })).toMatch(/still checking/);
    expect(mergeBlock({ ...pr, state: "merged" })).toMatch(/merged/);
    expect(mergeBlock({ ...pr, state: "closed" })).toMatch(/closed/);
  });
});

describe("the hosts the app knows", () => {
  it("which inputs the connect dialog shows", () => {
    expect(connectInputs("github", false, false)).toEqual({ instance: true, address: false, organization: false, username: false, gh: true });
    expect(connectInputs("gitea", true, false)).toEqual({ instance: true, address: true, organization: false, username: false, gh: false });
    expect(connectInputs("bitbucket", true, false)).toEqual({ instance: false, address: false, organization: false, username: true, gh: false });
    expect(connectInputs("azure_devops", false, false)).toEqual({ instance: false, address: false, organization: true, username: false, gh: false });
    // Replacing the token of an existing account: host, address and user name stay.
    expect(connectInputs("azure_devops", false, true)).toEqual({ instance: false, address: false, organization: false, username: false, gh: false });
    expect(connectInputs("github", true, true)).toMatchObject({ instance: false, address: false, gh: true });
  });

  it("accounts of every kind are read, unknown ones dropped; the user name comes along", () => {
    for (const kind of ["gitea", "bitbucket", "azure_devops"] as const) expect(toAccount({ ...account, kind })?.kind).toBe(kind);
    expect(toAccount({ ...account, kind: "bitbucket", username: "lena@example.org" })?.username).toBe("lena@example.org");
    expect(toAccount(account)?.username).toBeNull();
    expect(HOST_KINDS.map((kind) => hostKindLabels[kind])).toEqual(["GitHub", "GitLab", "Gitea/Forgejo", "Bitbucket", "Azure DevOps"]);
  });

  it("defaults per host: what Bitbucket and Azure DevOps cannot do", () => {
    expect(defaultCapabilities.bitbucket).toMatchObject({ prLabels: false, prReviewers: false, prReopen: false, forkCheckout: false, mergeMethods: ["merge", "squash"] });
    expect(defaultCapabilities.azure_devops).toMatchObject({ issueCreate: true, prReviewers: false, prLabels: true, forkCheckout: false });
    expect(defaultCapabilities.gitea.mergeMethods).toEqual(["merge", "squash", "rebase"]);
    expect(toCapabilities(undefined, "azure_devops").issueCreate).toBe(true);
  });

  it("token pages and how accounts are named", () => {
    expect(tokenPageUrl("gitea", null)).toBe("https://codeberg.org/user/settings/applications");
    expect(tokenPageUrl("gitea", "https://git.firma.example/")).toBe("https://git.firma.example/user/settings/applications");
    expect(tokenPageUrl("bitbucket", null)).toBe("https://id.atlassian.com/manage-profile/security/api-tokens");
    expect(tokenPageUrl("azure_devops", "https://dev.azure.com/firma")).toBe("https://dev.azure.com/firma/_usersSettings/tokens");
    expect(tokenPageUrl("azure_devops", null)).toBe("https://dev.azure.com");
    expect(accountHost({ kind: "azure_devops", baseUrl: "https://dev.azure.com/firma" })).toBe("dev.azure.com/firma");
    expect(accountHost({ kind: "bitbucket", baseUrl: null })).toBe("bitbucket.org");
  });

  it("what “Connect” sends per host", () => {
    const base = { kind: "github" as HostKind, own: false, address: "", organization: "", username: "" };
    expect(connectTarget(base)).toEqual({ ok: true, baseUrl: null, username: null });
    expect(connectTarget({ ...base, kind: "gitea", own: true, address: "git.firma.example/" })).toEqual({ ok: true, baseUrl: "https://git.firma.example", username: null });
    expect(connectTarget({ ...base, kind: "gitea", own: true, address: "" })).toMatchObject({ ok: false, field: "baseUrl" });
    expect(connectTarget({ ...base, kind: "azure_devops", organization: " Firma " })).toEqual({ ok: true, baseUrl: "https://dev.azure.com/firma", username: null });
    expect(connectTarget({ ...base, kind: "azure_devops", organization: "https://dev.azure.com/firma/projekt" })).toEqual({ ok: true, baseUrl: "https://dev.azure.com/firma", username: null });
    expect(connectTarget({ ...base, kind: "azure_devops" })).toMatchObject({ ok: false, field: "organization" });
    expect(connectTarget({ ...base, kind: "azure_devops", organization: "fir ma" })).toMatchObject({ ok: false, field: "organization" });
    expect(connectTarget({ ...base, kind: "bitbucket", username: " lena@example.org " })).toEqual({ ok: true, baseUrl: null, username: "lena@example.org" });
    expect(connectTarget({ ...base, kind: "bitbucket", own: true, address: "bitbucket.firma.example", username: "lena" })).toEqual({ ok: true, baseUrl: null, username: "lena" });
    expect(connectTarget({ ...base, kind: "bitbucket" })).toMatchObject({ ok: false, field: "username" });
    expect(connectTarget({ ...base, kind: "bitbucket", username: "lena:geheim" })).toMatchObject({ ok: false, field: "username" });
    expect(organizationOf("https://dev.azure.com/firma")).toBe("firma");
    expect(organizationOf(null)).toBe("");
  });

  it("the issue list at the host", () => {
    const repo = (kind: HostKind, webUrl: string) => toHostRepo({ kind, account: null, owner: "o", name: "n", webUrl });
    expect(issuesWebUrl(repo("gitlab", "https://gitlab.com/g/p"))).toBe("https://gitlab.com/g/p/-/issues");
    expect(issuesWebUrl(repo("gitea", "https://codeberg.org/a/b"))).toBe("https://codeberg.org/a/b/issues");
    expect(issuesWebUrl(repo("bitbucket", "https://bitbucket.org/team/demo"))).toBe("https://bitbucket.org/team/demo/issues");
    expect(issuesWebUrl(repo("azure_devops", "https://dev.azure.com/firma/projekt/_git/demo"))).toBe("https://dev.azure.com/firma/projekt/_workitems");
  });
});

describe("releases", () => {
  it("only GitHub, GitLab and Gitea/Forgejo offer releases by default", () => {
    expect(HOST_KINDS.filter((kind) => defaultCapabilities[kind].releases)).toEqual(["github", "gitlab", "gitea"]);
  });

  it("takes the core's flag and falls back to the host kind", () => {
    expect(toCapabilities({ releases: false }, "github").releases).toBe(false);
    expect(toCapabilities({}, "bitbucket").releases).toBe(false);
    expect(toCapabilities({ mergeMethods: ["merge"] }, "gitlab").releases).toBe(true);
  });
});

describe("review capabilities", () => {
  it("come from the core; the fallback lets every host read threads and only Gitea quote", () => {
    expect(toCapabilities({ reviewThreads: false, reviewReply: true, reviewReplyQuotes: true }, "github")).toMatchObject({ reviewThreads: false, reviewReply: true, reviewReplyQuotes: true });
    expect(toCapabilities({}, "gitea")).toMatchObject({ reviewThreads: true, reviewReply: true, reviewReplyQuotes: true });
    expect(toCapabilities(null, "azure_devops")).toMatchObject({ reviewThreads: true, reviewReply: true, reviewReplyQuotes: false });
    expect(defaultCapabilities.bitbucket.reviewReplyQuotes).toBe(false);
  });
});
