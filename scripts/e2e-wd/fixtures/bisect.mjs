/**
 * Fixtures for features/bisect.mjs: a linear history in which one commit breaks the temperature
 * conversion (the "bug" the bisect has to find), plus small Git-state readers for the asserts.
 * Builds on the isolated temp repositories of fixtures/rebase.mjs (fixed identity and dates).
 */
import fs from "node:fs";
import path from "node:path";
import { makeRepo } from "./rebase.mjs";

const GOOD_FORMULA = "def fahrenheit(c):\n    return c * 9 / 5 + 32\n";
const BAD_FORMULA = "def fahrenheit(c):\n    return c * 5 / 9 + 32\n";

/**
 * main: "Projekt angelegt", formula (tag v1.0), then `total - 2` more commits; the commit with
 * index `bugAt` (1-based after v1.0) swaps the factors. `shas[0]` is v1.0, `shas.at(-1)` HEAD.
 * Each later commit appends a measurement, so every commit touches `messwerte.csv`.
 */
export function makeBisectRepo({ name = "bisect-messnetz", total = 12, bugAt = 7 } = {}) {
  const repo = makeRepo(name);
  const removeNow = repo.cleanup;
  // The app may still write into .git (its own reads, the watcher) while the scenario ends:
  // retry, and leave a remainder to the exit hook of fixtures/rebase.mjs instead of failing.
  repo.cleanup = () => {
    try {
      fs.rmSync(repo.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      removeNow();
    } catch {
      // removed on exit
    }
  };
  repo.write("messwerte.csv", "datum;celsius\n");
  const shas = [repo.commit("umrechnung.py", GOOD_FORMULA, "Umrechnung in Fahrenheit")];
  repo.git("tag", "v1.0");
  let bug = null;
  for (let index = 1; index < total; index++) {
    const day = String(index).padStart(2, "0");
    fs.appendFileSync(path.join(repo.path, "messwerte.csv"), `2026-04-${day};${(10 + index / 2).toFixed(1)}\n`);
    if (index === bugAt) {
      repo.write("umrechnung.py", BAD_FORMULA);
      repo.git("add", "-A");
      repo.git("commit", "-q", "-m", "Umrechnung vereinfacht");
      bug = repo.tip();
    } else {
      repo.git("add", "-A");
      repo.git("commit", "-q", "-m", `Messwert vom 2026-04-${day}`);
    }
    shas.push(repo.tip());
  }
  return { repo, shas, bug, good: shas[0], head: shas.at(-1) };
}

/** Whether `sha` has the bug (Git's view of the file at that commit). */
export const hasBug = (repo, sha) => repo.git("show", `${sha}:umrechnung.py`).includes("5 / 9");

/** Bisect state straight from the Git directory. */
export function gitBisect(repo) {
  const dir = path.join(repo.path, ".git");
  const refs = repo.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/bisect").split("\n").filter(Boolean).map((line) => line.split(" "));
  return {
    active: fs.existsSync(path.join(dir, "BISECT_START")),
    refs: Object.fromEntries(refs),
    good: refs.filter(([name]) => name.startsWith("refs/bisect/good-")).map(([, sha]) => sha),
    skipped: refs.filter(([name]) => name.startsWith("refs/bisect/skip-")).map(([, sha]) => sha),
    bad: refs.find(([name]) => name === "refs/bisect/bad")?.[1] ?? null,
    head: repo.tip("HEAD"),
    branch: repo.gitMay("symbolic-ref", "-q", "--short", "HEAD").trim() || null,
    log: fs.existsSync(path.join(dir, "BISECT_LOG")) ? fs.readFileSync(path.join(dir, "BISECT_LOG"), "utf8") : "",
  };
}

/**
 * Git's own step estimate for the running bisect, independent of the app: `done` = marks in
 * BISECT_LOG (good, bad, skip), `remaining` = `bisect_steps` of
 * `git rev-list --bisect-vars <bad> ^<good>…` – the "roughly N steps" Git prints after a mark.
 */
export function gitBisectSteps(repo) {
  const state = gitBisect(repo);
  const done = state.log.split("\n").filter((line) => /^git bisect (good|bad|skip) /.test(line)).length;
  if (!state.bad || state.good.length === 0) return { done, remaining: null };
  const vars = repo.git("rev-list", "--bisect-vars", state.bad, ...state.good.map((sha) => `^${sha}`));
  const remaining = Number(/^bisect_steps=(\d+)$/m.exec(vars)?.[1] ?? NaN);
  return { done, remaining };
}
