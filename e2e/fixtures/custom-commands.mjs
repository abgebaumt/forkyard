/**
 * Fixtures for scripts/e2e-wd/features/custom-commands.mjs: a small real repository (the branch
 * fixture layout) plus helpers to write `.forkyard/commands.json` and command definitions.
 *
 *   const repo = makeCommandsRepo();   // { path, git, write, read, exists, commit, head, ..., writeCommands(list) }
 */
import fs from "node:fs";
import path from "node:path";
import { makeBranchRepo } from "./branches.mjs";

/** A complete command definition (the shape `customCommandsSave` and the files use). */
export function def(fields) {
  return { cwd: "worktree", confirm: false, shell: false, inputs: [], scope: ["repo"], ...fields };
}

/** Repository with main/feature branches and helpers for the repository command file. */
export function makeCommandsRepo(name = "befehle") {
  const repo = makeBranchRepo(name);
  const file = path.join(repo.path, ".forkyard", "commands.json");
  return {
    ...repo,
    commandsFile: file,
    /** Writes `.forkyard/commands.json` (format version 1) – raw text if `list` is a string. */
    writeCommands(list) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof list === "string" ? list : `${JSON.stringify({ version: 1, commands: list }, null, 2)}\n`);
    },
    tags: () => repo.git("tag", "--list").split("\n").filter(Boolean).sort(),
  };
}

/** Writes a JSON file in the format of an export; returns its path. */
export function writeCommandFile(dir, commands) {
  const target = path.join(dir, "import-befehle.json");
  fs.writeFileSync(target, `${JSON.stringify({ version: 1, commands }, null, 2)}\n`);
  return target;
}
