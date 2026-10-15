import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { FileChange, LfsLockList, LfsStatus } from "../../core";
import { qk } from "../../app/queries";
import { ChangedFiles } from "./FilesSection";

const file = (path: string): FileChange => ({ path, oldPath: null, status: "modified", area: "commit", isBinary: true, isLfs: true, added: null, removed: null, conflict: null });

describe("ChangedFiles", () => {
  it("shows the LFS lock symbol in a commit's changed files", () => {
    const client = new QueryClient();
    const lfs: LfsStatus = { installed: true, version: "3.7.1", patterns: ["*.psd"] };
    const locks: LfsLockList = {
      locks: [
        { id: "1", path: "daten/karte.psd", owner: "Jonas Berg", lockedAt: null, ours: false },
        { id: "2", path: "daten/logo.psd", owner: "Test Person", lockedAt: null, ours: true },
      ],
      fetchedAt: "2026-01-02T03:05:00.000Z",
    };
    client.setQueryData(qk.lfsInUse("r1"), lfs);
    client.setQueryData(qk.lfsLocks("r1"), locks);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ChangedFiles repoId="r1" tabId="t1" source={{ kind: "commit", sha: "a".repeat(40) }} files={[file("daten/karte.psd"), file("daten/logo.psd"), file("daten/plan.psd")]} view="flat" emptyText="" listLabel="Files" />
      </QueryClientProvider>,
    );
    expect(html.match(/data-lfs-lock="theirs"/g)?.length).toBe(1);
    expect(html.match(/data-lfs-lock="ours"/g)?.length).toBe(1);
    expect(html).toContain("Jonas Berg");
  });
});
