/**
 * Fixtures for features/worktrees-submodules.mjs: repositories with submodules from local bare
 * repositories (reusing scripts/e2e/screens/submodules-lib.mjs) and small helpers that read the
 * result straight from Git.
 */
import fs from "node:fs";
import path from "node:path";
import { makeCleanRepoWithRemote } from "../../e2e/fixtures.mjs";
import { git, gitFile, makeLibrary, readGitmodules, worktreeList } from "../../e2e/screens/submodules-lib.mjs";

export { git, gitFile, makeLibrary, readGitmodules, worktreeList };
export { LIBS, allowFileProtocol, makeSubmoduleRepo, startSilentServer } from "../../e2e/screens/submodules-lib.mjs";

export const SUB = "libs/sensor-treiber";

/**
 * Repository "station" with one submodule `libs/sensor-treiber` (library with three commits):
 * `main` records the third commit, branch `treiber-alt` the first. HEAD on main, the submodule
 * checked out at the third commit (in sync).
 */
export function makeAutoUpdateRepo() {
  const fx = makeCleanRepoWithRemote({ name: "station" });
  const lib = makeLibrary(fx, "sensor-treiber", { commits: 3 });
  gitFile(fx, fx.path, "submodule", "add", "-q", lib.path, SUB);
  git(fx, fx.path, "commit", "-q", "-m", "Sensor-Treiber als Submodul eingebunden");
  const sub = path.join(fx.path, SUB);
  git(fx, fx.path, "checkout", "-q", "-b", "treiber-alt");
  git(fx, sub, "checkout", "-q", lib.shas[0]);
  git(fx, fx.path, "add", SUB);
  git(fx, fx.path, "commit", "-q", "-m", "Sensor-Treiber auf Stand 1 zurückgesetzt");
  git(fx, fx.path, "checkout", "-q", "main");
  gitFile(fx, fx.path, "submodule", "update", "-q");
  return { fx, lib, sub };
}

/** `git submodule status` as { path: { flag, sha } }; flag: " " ok, "-" not initialized, "+" differs. */
export function subStatus(fx, repoPath) {
  return Object.fromEntries(
    gitFile(fx, repoPath, "submodule", "status")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const match = /^([ +\-U]?)([0-9a-f]{40}) (\S+)/.exec(line);
        return match ? [match[3], { flag: match[1] || " ", sha: match[2] }] : [line, { flag: "?", sha: "" }];
      }),
  );
}

/** Staged changes as "M .gitmodules", "R100 a b" … */
export const staged = (fx, repoPath) =>
  git(fx, repoPath, "diff", "--cached", "--name-status", "-M")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.replace(/\s+/g, " "));

export const modulePaths = (repoPath) =>
  readGitmodules(repoPath)
    .map((item) => item.path)
    .sort();

/** Snapshot of everything a failed or cancelled submodule operation must leave as it was. */
export const repoSnapshot = (fx, repoPath) => ({ modules: modulePaths(repoPath), status: git(fx, repoPath, "status", "--short") });

export const exists = (...parts) => fs.existsSync(path.join(...parts));
