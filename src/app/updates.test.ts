import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateInfo } from "../core";

const updateCheck = vi.fn<(input: { manual: boolean }) => Promise<UpdateInfo>>();
const updateDismiss = vi.fn<(input: { version: string; skip: boolean }) => Promise<UpdateInfo>>();
const toast = vi.fn();
const opened: string[] = [];
const errors: unknown[] = [];

vi.mock("../core", () => ({ core: { updateCheck: (input: { manual: boolean }) => updateCheck(input), updateDismiss: (input: { version: string; skip: boolean }) => updateDismiss(input) } }));
vi.mock("../ui/Feedback", () => ({ toast: (data: unknown) => toast(data) }));
vi.mock("./actions/hosts", () => ({
  openInBrowser: (url: string) => {
    opened.push(url);
    return Promise.resolve(true);
  },
}));
vi.mock("./run", () => ({
  runAction: async <T>(_label: string, fn: () => Promise<T>) => {
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      errors.push(error);
      return { ok: false, error };
    }
  },
}));

const { checkAutomatically, checkNow, getUpdateInfo, notesExcerpt, setUpdateInfo, skipVersion, toastDue, visibleUpdate } = await import("./updates");

const release = { version: "1.2.0", url: "https://github.com/abgebaumt/forkyard/releases/tag/v1.2.0", notes: "## Highlights\n\n- **Faster** graph\n- [Docs](https://example.com)", publishedAt: "2026-11-02T09:30:00Z" };
const info = (patch: Partial<UpdateInfo> = {}): UpdateInfo => ({ current: "1.1.0", latest: release, checkedAt: "2026-10-15T10:00:00.000Z", notifiedVersion: null, skippedVersion: null, ...patch });

type ToastArg = { title: string; description?: string; action?: { label: string; onClick: () => void }; secondaryAction?: { label: string; onClick: () => void } };
const lastToast = () => toast.mock.calls.at(-1)?.[0] as ToastArg;

beforeEach(() => {
  updateCheck.mockReset();
  updateDismiss.mockReset();
  toast.mockReset();
  opened.length = 0;
  errors.length = 0;
  setUpdateInfo(null);
  updateDismiss.mockImplementation(async ({ version, skip }) => info({ notifiedVersion: version, skippedVersion: skip ? version : null }));
});

describe("status bar hint", () => {
  it("shows a newer release unless it was skipped", () => {
    expect(visibleUpdate(info())?.version).toBe("1.2.0");
    expect(visibleUpdate(info({ notifiedVersion: "1.2.0" }))?.version).toBe("1.2.0");
    expect(visibleUpdate(info({ skippedVersion: "1.2.0" }))).toBeNull();
    expect(visibleUpdate(info({ skippedVersion: "1.1.5" }))?.version).toBe("1.2.0");
    expect(visibleUpdate(info({ latest: null }))).toBeNull();
    expect(visibleUpdate(null)).toBeNull();
  });
});

describe("toast once per version", () => {
  it("is due only for a version not seen and not skipped", () => {
    expect(toastDue(info())).toBe(true);
    expect(toastDue(info({ notifiedVersion: "1.2.0" }))).toBe(false);
    expect(toastDue(info({ notifiedVersion: "1.1.9" }))).toBe(true);
    expect(toastDue(info({ skippedVersion: "1.2.0" }))).toBe(false);
    expect(toastDue(info({ latest: null }))).toBe(false);
  });

  it("the automatic check shows the toast with version and notes, then marks the version as seen", async () => {
    updateCheck.mockResolvedValueOnce(info());
    await checkAutomatically();
    expect(updateCheck).toHaveBeenCalledWith({ manual: false });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(lastToast().title).toContain("1.2.0");
    expect(lastToast().description).toContain("Faster graph");
    expect(updateDismiss).toHaveBeenCalledWith({ version: "1.2.0", skip: false });
    expect(getUpdateInfo()?.notifiedVersion).toBe("1.2.0");

    // The next check (the core says: already seen) shows nothing again.
    updateCheck.mockResolvedValueOnce(info({ notifiedVersion: "1.2.0" }));
    await checkAutomatically();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(visibleUpdate(getUpdateInfo())?.version).toBe("1.2.0");
  });

  it("the toast opens the release page and can skip the version", async () => {
    updateCheck.mockResolvedValueOnce(info());
    await checkAutomatically();
    lastToast().action?.onClick();
    expect(opened).toEqual([release.url]);
    lastToast().secondaryAction?.onClick();
    await vi.waitFor(() => expect(updateDismiss).toHaveBeenCalledWith({ version: "1.2.0", skip: true }));
    await vi.waitFor(() => expect(visibleUpdate(getUpdateInfo())).toBeNull());
  });

  it("errors of the automatic check stay quiet", async () => {
    updateCheck.mockRejectedValueOnce({ code: "host_rate_limited", message: "limit", gitOutput: null });
    await checkAutomatically();
    updateCheck.mockRejectedValueOnce({ code: "offline", message: "offline", gitOutput: null });
    await checkAutomatically();
    expect(toast).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });
});

describe("skip this version", () => {
  it("hides the hint and stores the choice in the core", async () => {
    setUpdateInfo(info());
    await skipVersion("1.2.0");
    expect(updateDismiss).toHaveBeenCalledWith({ version: "1.2.0", skip: true });
    expect(visibleUpdate(getUpdateInfo())).toBeNull();
  });
});

describe("manual check", () => {
  it("reports “up to date” with the current version", async () => {
    updateCheck.mockResolvedValueOnce(info({ latest: null }));
    await checkNow();
    expect(updateCheck).toHaveBeenCalledWith({ manual: true });
    expect(lastToast().title).toContain("1.1.0");
    expect(lastToast().action).toBeUndefined();
  });

  it("shows a newer version even if its notice was already seen or skipped", async () => {
    updateCheck.mockResolvedValueOnce(info({ notifiedVersion: "1.2.0", skippedVersion: "1.2.0" }));
    await checkNow();
    expect(lastToast().title).toContain("1.2.0");
    expect(lastToast().action).toBeDefined();
  });

  it("errors are shown", async () => {
    updateCheck.mockRejectedValueOnce({ code: "offline", message: "offline", gitOutput: null });
    await checkNow();
    expect(errors).toHaveLength(1);
  });
});

describe("setting toggle", () => {
  it("turning the setting off hides the hint after the next check", async () => {
    updateCheck.mockResolvedValueOnce(info({ notifiedVersion: "1.2.0" }));
    await checkAutomatically();
    expect(visibleUpdate(getUpdateInfo())).not.toBeNull();
    // With the setting off the core answers without a release.
    updateCheck.mockResolvedValueOnce(info({ latest: null, notifiedVersion: "1.2.0" }));
    await checkAutomatically();
    expect(visibleUpdate(getUpdateInfo())).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("release notes excerpt", () => {
  it("is plain text without Markdown syntax", () => {
    expect(notesExcerpt(release.notes)).toBe("Highlights · Faster graph · Docs");
  });
  it("is shortened at a word boundary", () => {
    const text = notesExcerpt("word ".repeat(200), 50);
    expect(text.length).toBeLessThanOrEqual(51);
    expect(text.endsWith("…")).toBe(true);
    expect(text).not.toMatch(/ …$/);
  });
  it("drops HTML tags, images and code fences", () => {
    expect(notesExcerpt('<img src=x onerror="alert(1)">Hello ![logo](a.png) `code`\n```\nrm -rf /\n```\nWorld')).toBe("Hello code · World");
  });
  it("is empty for empty notes", () => {
    expect(notesExcerpt("  \n ")).toBe("");
  });
});
