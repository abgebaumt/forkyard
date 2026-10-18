import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const changelogInsert = vi.fn(async (input: unknown) => {
  calls.push("changelog_insert");
  void input;
  return { path: "CHANGELOG.md", created: false, keepAChangelog: true };
});
const releaseCreate = vi.fn(async (input: unknown) => {
  calls.push("release_create");
  void input;
  return { tag: "v1.2.0", name: "v1.2.0", webUrl: null };
});
let hostInfo: unknown = null;
const confirmSpy = vi.fn(async (options: { title: string; body: unknown; confirmLabel: string; danger?: boolean }) => {
  void options;
  return true;
});
let pushStatus: "pushed" | "up_to_date" | "rejected" = "pushed";
const pushTagSpy = vi.fn(async (repoId: string, name: string, remote?: string | null) => {
  calls.push(`tag_push ${name} ${remote}`);
  void repoId;
  return { ok: true as const, value: { status: pushStatus } };
});
const copySpy = vi.fn(async (text: string, what: string) => {
  calls.push("copy");
  void text;
  void what;
  return true;
});

vi.mock("../../core", async (original) => ({
  ...(await original<typeof import("../../core")>()),
  core: {
    changelogInsert: (input: unknown) => changelogInsert(input),
    releaseCreate: (input: unknown) => releaseCreate(input),
    hostRepoInfo: async () => hostInfo,
    on: () => () => undefined,
  },
}));
vi.mock("../../app/dialogs", async (original) => ({
  ...(await original<typeof import("../../app/dialogs")>()),
  confirm: (options: { title: string; body: unknown; confirmLabel: string; danger?: boolean }) => confirmSpy(options),
}));
vi.mock("../../app/actions/tags", () => ({ pushTag: (repoId: string, name: string, remote?: string | null) => pushTagSpy(repoId, name, remote) }));
vi.mock("../../app/actions/clipboard", () => ({ copyText: (text: string, what: string) => copySpy(text, what) }));
vi.mock("../../ui/Feedback", async (original) => ({ ...(await original<typeof import("../../ui/Feedback")>()), toast: vi.fn() }));

const { queryClient } = await import("../../app/queries");
const { applyReleaseTargets } = await import("./apply");

const NOTES = "### Neu\n\n- Export als CSV\n\n### Behoben\n\n- Absturz bei leerem Namen";
const github = { remote: "origin", kind: "github", account: { id: "a1", kind: "github" }, owner: "octo", name: "demo", webUrl: "https://github.com/octo/demo", capabilities: { releases: true } };

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
  queryClient.clear();
  hostInfo = github;
  pushStatus = "pushed";
  confirmSpy.mockImplementation(async () => true);
});

describe("applying release notes", () => {
  it("runs changelog, host release and clipboard in this order, whatever order they were picked in", async () => {
    const done = await applyReleaseTargets({ repoId: "r1", tag: "v1.2.0", notes: NOTES, targets: ["clipboard", "host_release", "changelog"] });
    expect(done).toEqual(["changelog", "host_release", "clipboard"]);
    expect(calls).toEqual(["changelog_insert", "tag_push v1.2.0 origin", "release_create", "copy"]);
    expect(changelogInsert.mock.calls[0]![0]).toMatchObject({ repoId: "r1", version: "v1.2.0", notes: NOTES });
    expect((changelogInsert.mock.calls[0]![0] as { date: string }).date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(releaseCreate.mock.calls[0]![0]).toEqual({ repoId: "r1", tag: "v1.2.0", name: "v1.2.0", body: NOTES, prerelease: false, remote: "origin" });
    expect(copySpy).toHaveBeenCalledWith(NOTES, "Release notes");
  });

  it("the host release is confirmed on its own, pushes the tag first and stops on failure", async () => {
    await applyReleaseTargets({ repoId: "r1", tag: "v1.2.0", notes: NOTES, targets: ["host_release"] });
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const options = confirmSpy.mock.calls[0]![0];
    expect(options.title).toBe("Create release on GitHub?");
    expect(String(options.body)).toContain("“v1.2.0” to origin");
    expect(String(options.body)).toContain("cannot be undone");
    expect(options).toMatchObject({ confirmLabel: "Push and create release", danger: true });

    calls.length = 0;
    confirmSpy.mockImplementation(async () => false);
    expect(await applyReleaseTargets({ repoId: "r1", tag: "v1.2.0", notes: NOTES, targets: ["changelog", "host_release", "clipboard"] })).toEqual(["changelog"]);
    expect(calls, "declined: no push, no release, and the clipboard is not reached").toEqual(["changelog_insert"]);

    calls.length = 0;
    confirmSpy.mockImplementation(async () => true);
    pushStatus = "rejected";
    expect(await applyReleaseTargets({ repoId: "r1", tag: "v1.2.0", notes: NOTES, targets: ["host_release", "clipboard"] })).toEqual([]);
    expect(calls, "a rejected push creates no release").toEqual(["tag_push v1.2.0 origin"]);
  });

  it("an already pushed tag still gets its release", async () => {
    pushStatus = "up_to_date";
    expect(await applyReleaseTargets({ repoId: "r1", tag: "v1.2.0", notes: NOTES, targets: ["host_release"] })).toEqual(["host_release"]);
    expect(calls).toEqual(["tag_push v1.2.0 origin", "release_create"]);
  });

  it("a host without releases never gets asked", async () => {
    hostInfo = { ...github, kind: "bitbucket", account: { id: "a2", kind: "bitbucket" }, capabilities: {} };
    expect(await applyReleaseTargets({ repoId: "r1", tag: "v1.2.0", notes: NOTES, targets: ["host_release"] })).toEqual([]);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("without a tag only the clipboard can be applied", async () => {
    expect(await applyReleaseTargets({ repoId: "r1", tag: null, notes: NOTES, targets: ["clipboard"] })).toEqual(["clipboard"]);
    expect(changelogInsert).not.toHaveBeenCalled();
  });
});
