/**
 * Effect of the setting "Commits on first load": the first page of the graph brings exactly as many
 * commits as configured – checked in the real app against a repository with 6000 commits.
 *
 *   node scripts/e2e/screens/initial-commits.mjs
 */
import { launchApp } from "../driver.mjs";
import { makeLargeRepo } from "../fixtures.mjs";

const TOTAL = 6000;
const repo = makeLargeRepo(TOTAL);
let failed = 0;
const check = (ok, text) => {
  console.log(`${ok ? "✓" : "✗"} ${text}`);
  if (!ok) failed += 1;
};

/** Commits of the first page according to the UI's query cache (without the local changes row). */
async function firstPageCommits(app, repoId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const count = await app.page.evaluate((id) => {
      const data = window.__gc.queryClient.getQueryData(["repo", id, "graph"]);
      const first = data?.pages?.[0];
      return first ? first.rows.filter((row) => row.kind === "commit" || row.kind === "merge").length : null;
    }, repoId);
    if (count !== null) return count;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

for (const wanted of [500, 3000]) {
  const app = await launchApp();
  try {
    await app.invoke("settings_set", { patch: { initialCommits: wanted, autoFetchMinutes: 0 } });
    const { repoId } = await app.openRepo(repo.path);
    const loaded = await firstPageCommits(app, repoId);
    check(loaded === wanted, `Setting ${wanted}: the first page brings ${loaded} of ${TOTAL} commits`);
  } finally {
    await app.close();
  }
}

console.log(failed ? `initial-commits: ${failed} red.` : "initial-commits: green.");
process.exit(failed ? 1 : 0);
