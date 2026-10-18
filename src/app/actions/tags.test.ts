import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RefsSnapshot } from "../../core";

type CreateInput = { repoId: string; name: string; sha: string | null; message: string | null };
const tagCreate = vi.fn<(input: CreateInput) => Promise<RefsSnapshot>>();
const askTagSpy = vi.fn<(options: Record<string, unknown>) => Promise<unknown>>();
const applySpy = vi.fn<(input: unknown) => Promise<string[]>>();

vi.mock("../../core", async (original) => ({
  ...(await original<typeof import("../../core")>()),
  core: { tagCreate: (input: CreateInput) => tagCreate(input), on: () => () => undefined },
}));
vi.mock("../actionDialogs", () => ({ askTag: (options: Record<string, unknown>) => askTagSpy(options) }));
vi.mock("../../screens/ReleaseNotes/apply", () => ({ applyReleaseTargets: (input: unknown) => applySpy(input) }));
vi.mock("../../ui/Feedback", async (original) => ({ ...(await original<typeof import("../../ui/Feedback")>()), toast: vi.fn() }));

const { createTag } = await import("./tags");
const SHA = "c".repeat(40);
const NOTES = "### Neu\n\n- Export als CSV";

beforeEach(() => {
  vi.clearAllMocks();
  tagCreate.mockResolvedValue({ locals: [], remotes: [], tags: [], head: null } as unknown as RefsSnapshot);
  applySpy.mockResolvedValue(["changelog"]);
});

describe("creating a tag with release notes", () => {
  it("passes repository and commit to the dialog", async () => {
    askTagSpy.mockResolvedValue(null);
    await createTag("r1", SHA, true);
    expect(askTagSpy.mock.calls[0]![0]).toMatchObject({ repoId: "r1", sha: SHA, annotated: true });
  });

  it("applies the chosen targets only after the tag exists, with the annotation as notes", async () => {
    askTagSpy.mockResolvedValue({ name: "v1.2.0", message: NOTES, targets: ["changelog", "host_release"] });
    await createTag("r1", SHA, true);
    expect(tagCreate).toHaveBeenCalledWith({ repoId: "r1", name: "v1.2.0", sha: SHA, message: NOTES });
    expect(applySpy).toHaveBeenCalledWith({ repoId: "r1", tag: "v1.2.0", notes: NOTES, targets: ["changelog", "host_release"] });
    expect(tagCreate.mock.invocationCallOrder[0]!).toBeLessThan(applySpy.mock.invocationCallOrder[0]!);
  });

  it("does nothing else when the tag could not be created or no target was chosen", async () => {
    askTagSpy.mockResolvedValue({ name: "v1.2.0", message: NOTES, targets: ["changelog"] });
    tagCreate.mockRejectedValueOnce({ code: "name_exists", message: "A tag named “v1.2.0” already exists.", gitOutput: null });
    await createTag("r1", SHA, true);
    askTagSpy.mockResolvedValue({ name: "v1.3.0", message: NOTES, targets: [] });
    await createTag("r1", SHA, true);
    expect(applySpy).not.toHaveBeenCalled();
  });
});
