/**
 * F06 – pull, push, fetch: the test cases no other script covered yet. In the real app, against real
 * Git repositories with a bare "origin" in the same temp folder and – for credentials – against the
 * local test server (git-http-server.mjs). Never against real services.
 *
 *   node scripts/e2e/flows/C-F06.mjs                 everything
 *   node scripts/e2e/flows/C-F06.mjs --only F06-N1   only sections whose title or case id contains the text
 *   node scripts/e2e/flows/C-F06.mjs --show          visible window
 *
 * Covered elsewhere: fetch/pull/push, "Where to push?", rejected → pull first / force, pull with
 * conflict and with changes in the way, no remote, unreachable remote on fetch, cancelling a fetch,
 * credential prompt (screens/interaction.mjs), pull modes, auto-fetch (screens/mustfix-sync.mjs),
 * remembered and expired credentials (screens/mustfix-https.mjs).
 *
 * "Slow network" here is a remote whose other end only answers after a few seconds
 * (remote.origin.uploadpack / receivepack with a delay) – the delay is on the remote's side.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { startGitHttpServer } from "../git-http-server.mjs";
import { commit, createFlow, currentBranch, gitRaw, head, lines, make, porcelain, readFile, remoteGit, removeHook, sleep, stashList, writeHook } from "./C-lib.mjs";

const t = createFlow("C-F06");
const { check, equal, eventually, section } = t;

const closedPort = await new Promise((resolve) => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
let server = null;

try {
  const app = await t.launch();
  const { page } = app;
  const repo = await t.open(t.made(make(() => makeCleanRepoWithRemote({ name: "abgleich" }))));
  const remoteHead = (branch = "main") => remoteGit(repo, "rev-parse", `refs/heads/${branch}`);
  const remoteHas = (branch) => lines(remoteGit(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads")).includes(branch);
  const pullLabel = () => t.toolState("Pull").then((state) => state.label);
  const pushLabel = () => t.toolState("Push").then((state) => state.label);
  const upstreamOf = (branch) => gitRaw(repo, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], { allowFail: true });
  const jobs = () => page.evaluate(() => Object.keys(window.__gc.store.getState().jobs).length);
  const progress = () => page.locator('footer [role="progressbar"]').count();
  /** Put everything in order: main checked out, local = remote. */
  const level = async () => {
    gitRaw(repo, ["merge", "--abort"], { allowFail: true });
    if (currentBranch(repo) !== "main") gitRaw(repo, ["checkout", "-q", "-f", "main"]);
    gitRaw(repo, ["fetch", "-q", "origin"]);
    gitRaw(repo, ["reset", "-q", "--hard", "origin/main"]);
    await t.refresh(repo.repoId);
  };

  // ---------------------------------------------------------------------------------------------
  await section(["F06-E10"], "Changed from outside while the app is open: commit and fetch in the terminal – the counters on Push and Pull follow by themselves", async () => {
    equal(await pushLabel(), null, "starting point: nothing to push");
    commit(repo, "aussen.txt", "eins\n", "Commit aus dem Terminal");
    await eventually(pushLabel, "Push, 1 commit to push", "a commit in the terminal: Push shows \"1 commit to push\" by itself", 25_000);
    await eventually(() => page.locator("footer").getByLabel("1 commit ahead").count(), 1, "the status bar shows ↑1", 10_000);
    const remoteSha = repo.commitOnRemote({ message: "Nachtrag, während die App offen ist" });
    gitRaw(repo, ["fetch", "-q", "origin"]);
    await eventually(pullLabel, "Pull, 1 commit to pull", "a fetch in the terminal: Pull shows \"1 commit to pull\" by itself", 25_000);
    await eventually(() => page.locator("footer").getByLabel("1 commit behind").count(), 1, "the status bar shows ↓1", 10_000);
    await eventually(() => t.graphRow(remoteSha).count(), 1, "the graph shows the fetched commit", 15_000);
    await t.noErrorToast("no error toast");
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F06-E11"], "Double click on Pull and on Push: exactly one action each, no error", async () => {
    // State from the previous section: 1 ahead, 1 behind.
    await t.refresh(repo.repoId);
    const remoteBefore = remoteHead();
    await t.toolButton("Pull").dblclick();
    await t.waitToast(/Pull complete/, "success", 60_000);
    await eventually(() => gitRaw(repo, ["merge-base", "--is-ancestor", remoteBefore, "HEAD"], { allowFail: true }), "", "git: the remote's commit is contained after the pull");
    await sleep(1500);
    await t.noErrorToast("double click on Pull: no error toast");
    equal((await t.toasts()).filter((toast) => /Pull complete/.test(toast.text)).length, 1, "exactly one success toast for the pull");
    equal(porcelain(repo), [], "git: clean, no half merge");
    await t.closeToasts();
    await app.settle();
    const local = head(repo);
    await eventually(async () => (await t.toolState("Push")).disabled, false, "Push is enabled");
    await t.toolButton("Push").dblclick();
    await t.waitToast(/Pushed to origin\/main/, "success", 60_000);
    equal(remoteHead(), local, "git: the remote is on the local commit");
    await sleep(1500);
    await t.noErrorToast("double click on Push: no error toast");
    equal((await t.toasts()).filter((toast) => /Pushed/.test(toast.text)).length, 1, "exactly one success toast for the push");
    equal(await t.dialogTitle(), null, "no dialog (\"rejected\") from the second click");
    equal(await jobs(), 0, "no job is running any more");
    await t.closeToasts();
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F06-E7", "F06-E9", "F06-E12a"], "\"Where to push?\": empty and invalid name disable \"Push\"; Esc pushes nothing and sets no upstream", async () => {
    gitRaw(repo, ["checkout", "-q", "-b", "thema/ohne-ziel"]);
    commit(repo, "ziel.txt", "x\n", "Commit ohne Upstream");
    await t.refresh(repo.repoId);
    await t.toolButton("Push").click();
    const dialog = await t.waitDialog(/^Where to push\?$/);
    const field = dialog.getByLabel("Branch name on the remote");
    const pushButton = dialog.getByRole("button", { name: "Push" });
    equal(await field.inputValue(), "thema/ohne-ziel", "the name is prefilled");
    await field.fill("");
    equal(await pushButton.isDisabled(), true, "empty name: \"Push\" is disabled");
    await field.press("Enter");
    await sleep(400);
    equal(await t.dialogTitle(), "Where to push?", "Enter with an empty name does not close the dialog");
    await field.fill("thema/a..b");
    await eventually(() => dialog.getByRole("alert").count(), 1, "invalid name: reason at the field");
    equal(await pushButton.isDisabled(), true, "invalid name: \"Push\" is disabled");
    await field.fill("");
    await page.keyboard.type("thema/mit leerzeichen");
    equal(await field.inputValue(), "thema/mit-leerzeichen", "spaces become \"-\"");
    check((await dialog.innerText()).includes("origin/thema/mit-leerzeichen"), "the dialog says what would be created");
    await page.keyboard.press("Escape");
    await t.noDialog();
    await sleep(600);
    equal(remoteHas("thema/mit-leerzeichen") || remoteHas("thema/ohne-ziel"), false, "git: Esc put nothing on the remote");
    equal(upstreamOf("thema/ohne-ziel"), null, "git: no upstream set");
    await t.noErrorToast("cancelling is not an error");
    equal(await jobs(), 0, "no job running");
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F06-E8"], "Umlauts, emoji and a long name: push a branch to the remote under its own name, then pull from there", async () => {
    const local = "thema/größe-🌧️-messen";
    const remoteName = `thema/größe-🌧️-${"fernes-ziel-".repeat(5)}ende`;
    check(remoteName.length >= 60, `the name on the remote has ${remoteName.length} characters`);
    gitRaw(repo, ["checkout", "-q", "-b", local, "main"]);
    const sha = commit(repo, "größe.txt", "Körpergröße in cm\n", "Größen erfassen 🌧️");
    await t.refresh(repo.repoId);
    await t.toolButton("Push").click();
    const dialog = await t.waitDialog(/^Where to push\?$/);
    equal(await dialog.getByLabel("Branch name on the remote").inputValue(), local, "prefilled with umlauts and emoji");
    await dialog.getByLabel("Branch name on the remote").fill(remoteName);
    check(await t.inViewport(dialog), "the dialog stays inside the window");
    equal(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth), true, "the long name does not break the dialog");
    await dialog.getByRole("button", { name: "Push" }).click();
    await t.waitToast(/Pushed/, "success", 60_000);
    equal(remoteHead(remoteName), sha, "git (bare): the branch is on the remote under exactly this name");
    equal(upstreamOf(local), `origin/${remoteName}`, "git: the upstream points to the differently named remote branch");
    await t.closeToasts();
    const remoteSha = repo.commitOnRemote({ branch: remoteName, file: "docs/größe.md", message: "Nachtrag auf dem Branch mit Emoji" });
    await t.toolButton("Fetch").click();
    await t.waitToast(/Fetch complete/, "success", 60_000);
    await t.closeToasts();
    await eventually(pullLabel, "Pull, 1 commit to pull", "after the fetch: 1 commit to pull");
    await t.toolButton("Pull").click();
    await t.waitToast(/Pull complete/, "success", 60_000);
    equal(head(repo), remoteSha, "git: the pull got the commit from the differently named upstream");
    equal(await t.overflow(), { x: 0, y: 0 }, "no page overflow");
    await t.closeToasts();
  });
  await level();

  // ---------------------------------------------------------------------------------------------
  await section(["F06-E12b"], "Cancel midway: \"Push rejected\" with Esc, \"Force push?\" with \"Cancel\" – nothing changes", async () => {
    const remoteSha = repo.commitOnRemote({ file: "docs/fremd.md", message: "Fremder Commit, den lokal niemand hat" });
    const local = commit(repo, "eigen.txt", "eigen\n", "Eigener Commit");
    await t.refresh(repo.repoId);
    await t.toolButton("Push").click();
    await t.waitDialog(/^Push rejected$/, 60_000);
    await page.keyboard.press("Escape");
    await t.noDialog();
    equal(remoteHead(), remoteSha, "git (bare): Esc leaves the remote as it is");
    equal(head(repo), local, "git: local unchanged");
    equal(porcelain(repo), [], "git: no half pull");
    await t.closeToasts();
    await app.settle();
    await t.toolButton("Push").click();
    await (await t.waitDialog(/^Push rejected$/, 60_000)).getByRole("button", { name: /^Force push/ }).click();
    const force = await t.waitDialog(/^Force push to origin\/main\?$/, 60_000);
    equal((await t.focused()).text, "Cancel", "in the confirmation the focus is on \"Cancel\"");
    await force.getByRole("button", { name: "Cancel" }).click();
    await t.noDialog();
    await sleep(800);
    equal(remoteHead(), remoteSha, "git (bare): \"Cancel\" overwrites nothing on the remote");
    equal(head(repo), local, "git: local unchanged");
    equal(await jobs(), 0, "no job is running any more");
    await t.noErrorToast("cancelling is not an error");
    await t.closeToasts();
  });
  await level();

  // ---------------------------------------------------------------------------------------------
  await section(["F06-E6", "F06-N4"], "Offline: push and pull against an unreachable remote fail clearly; nothing is lost; afterwards it works again", async () => {
    const local = commit(repo, "offline.txt", "eins\n", "Commit vor dem Funkloch");
    const good = gitRaw(repo, ["remote", "get-url", "origin"]);
    gitRaw(repo, ["remote", "set-url", "origin", `http://127.0.0.1:${closedPort}/abgleich.git`]);
    await t.refresh(repo.repoId);
    try {
      await t.toolButton("Push").click();
      const pushFailed = await t.waitToast(/Push failed/, "danger", 90_000);
      check(/can.t be reached|connection|network/i.test(pushFailed?.text ?? ""), `Push: the message explains that the remote can't be reached: ${pushFailed?.text}`);
      check(!/fatal:|[Ee]xit code/.test(pushFailed?.text ?? ""), "Push: in its own words, not as raw Git output");
      equal(head(repo), local, "git: the local commit is intact");
      await eventually(pushLabel, "Push, 1 commit to push", "the counter on Push stays");
      equal(await t.dialogTitle(), null, "no \"Push rejected\" dialog – offline is not a rejection");
      await t.closeToasts();
      await page.keyboard.press("Control+Shift+D");
      const pullFailed = await t.waitToast(/Pull failed/, "danger", 90_000);
      check(/can.t be reached|connection|network/i.test(pullFailed?.text ?? ""), `Pull: the message explains that the remote can't be reached: ${pullFailed?.text}`);
      equal(head(repo), local, "git: HEAD unchanged");
      equal(porcelain(repo), [], "git: working directory clean");
      equal(await jobs(), 0, "no job is left hanging");
      await t.closeToasts();
      // Remote whose folder no longer exists (local path).
      gitRaw(repo, ["remote", "set-url", "origin", path.join(repo.root, "gibt-es-nicht.git")]);
      await t.refresh(repo.repoId);
      await t.toolButton("Fetch").click();
      const gone = await t.waitToast(/Fetch.*failed/, "danger", 60_000);
      check((gone?.text ?? "").length > 40 && !/fatal:/.test(gone?.text ?? ""), `fetch against a vanished folder: clear message: ${gone?.text}`);
      await t.closeToasts();
    } finally {
      gitRaw(repo, ["remote", "set-url", "origin", good]);
    }
    await t.refresh(repo.repoId);
    await t.toolButton("Push").click();
    await t.waitToast(/Pushed to origin\/main/, "success", 60_000);
    equal(remoteHead(), local, "git (bare): as soon as the remote is back, the commit arrives");
    await t.closeToasts();
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F06-E14"], "Slow network: fetch and push take seconds – progress visible, the app stays usable, in the end everything is right", async () => {
    const remoteSha = repo.commitOnRemote({ file: "docs/langsam.md", message: "Kommt über die langsame Leitung" });
    gitRaw(repo, ["config", "remote.origin.uploadpack", "sleep 5; git-upload-pack"]);
    try {
      const started = Date.now();
      await t.toolButton("Fetch").click();
      await eventually(() => t.toolState("Fetch").then((state) => state.busy), true, "Fetch is \"busy\" while waiting (aria-busy)");
      await eventually(progress, 1, "the status bar shows the running job");
      // Meanwhile: select a commit in the graph, read the details.
      const second = gitRaw(repo, ["rev-parse", "main~1"]);
      await t.graphRow(second).click();
      await eventually(() => t.selection(repo.tabId), { kind: "commits", shas: [second] }, "a commit can be selected during the fetch");
      await page.locator(`[data-screen="commit-details"] code[title="${second}"]`).waitFor({ timeout: 4000 });
      check(Date.now() - started < 5000, `the details were there before the fetch finished (${Date.now() - started} ms)`);
      check((await t.toolState("Pull")).disabled && /Fetch (is )?running/.test(await t.toolHint("Pull")), "Pull is disabled meanwhile, with a reason");
      const done = await t.waitToast(/Fetch complete/, "success", 60_000);
      check(Date.now() - started >= 4500, `the fetch really waited (${Date.now() - started} ms)`);
      check(/1 ref updated/.test(done?.text ?? ""), `the toast says what came in: ${done?.text}`);
      equal(gitRaw(repo, ["rev-parse", "origin/main"]), remoteSha, "git: origin/main is up to date");
      await eventually(progress, 0, "the job has disappeared from the status bar");
    } finally {
      gitRaw(repo, ["config", "--unset", "remote.origin.uploadpack"], { allowFail: true });
    }
    await t.closeToasts();
    gitRaw(repo, ["merge", "-q", "--ff-only", "origin/main"]);
    const local = commit(repo, "langsam.txt", "lokal\n", "Geht über die langsame Leitung hinaus");
    gitRaw(repo, ["config", "remote.origin.receivepack", "sleep 4; git-receive-pack"]);
    await t.refresh(repo.repoId);
    try {
      const started = Date.now();
      await t.toolButton("Push").click();
      await eventually(() => t.toolState("Push").then((state) => state.busy), true, "Push is \"busy\" while waiting");
      await eventually(progress, 1, "the status bar shows the running push");
      equal(remoteHead() === local, false, "while the push runs, the commit is not on the remote yet");
      await t.waitToast(/Pushed to origin\/main/, "success", 60_000);
      check(Date.now() - started >= 3500, `the push really waited (${Date.now() - started} ms)`);
      equal(remoteHead(), local, "git (bare): the commit has arrived");
      await eventually(pushLabel, null, "the counter on Push is gone");
    } finally {
      gitRaw(repo, ["config", "--unset", "remote.origin.receivepack"], { allowFail: true });
    }
    await t.closeToasts();
  });
  await level();

  // ---------------------------------------------------------------------------------------------
  // When a hook rejects the push, the app names the hook and its output – and does not offer
  // "Pull first" / "Force push", because neither changes the hook's verdict.
  await section(
    ["F06-N1"],
    "Hook declines: pre-push fails – nothing is pushed, the message names hook and output",
    async () => {
      const before = remoteHead();
      const local = commit(repo, "hook.txt", "x\n", "Commit, den der Hook nicht durchlässt");
      writeHook(repo, "pre-push", 'echo "pre-push: Erst die Tests laufen lassen (make test)." >&2\nexit 1');
      await t.refresh(repo.repoId);
      try {
        await t.toolButton("Push").click();
        const seen = await t.until(async () => ({ dialog: await t.dialogTitle(), toasts: await t.toasts() }), (state) => state.dialog !== null || state.toasts.some((toast) => toast.tone === "danger"), 60_000);
        const dialogText = seen.actual.dialog ? (await page.locator('[role="dialog"]').last().innerText()).replace(/\s+/g, " ") : "";
        const all = `${dialogText} ${seen.actual.toasts.map((toast) => toast.text).join(" ")}`;
        check(/pre-push/.test(all), `the message names the hook "pre-push": ${all.slice(0, 400)}`);
        check(/Erst die Tests laufen lassen/.test(all), "… and shows its output");
        equal(remoteHead(), before, "git (bare): nothing was pushed");
        equal(head(repo), local, "git: the local commit is intact");
        check(!/Pull first/.test(dialogText), `after a hook's no the app does not offer "Pull first" (it changes nothing): ${dialogText.slice(0, 300)}`);
        check(!/Force push/.test(dialogText), "… nor \"Force push\" (the hook runs then too)");
      } finally {
        removeHook(repo, "pre-push");
      }
    },
  );
  await level();

  // ---------------------------------------------------------------------------------------------
  // BUG C-04: When the server rejects the push (pre-receive), the message only shows "[remote rejected]
  // (pre-receive hook declined)". What the server wrote – the actual reason – is only behind
  // "Show output".
  await section(
    ["F06-N2"],
    "Remote declines: the server's pre-receive hook says no – the server's reason is in the message, nothing changed",
    async () => {
      const before = remoteHead();
      const local = commit(repo, "richtlinie.txt", "x\n", "Commit ohne Ticketnummer");
      const hook = path.join(repo.remotePath, "hooks", "pre-receive");
      fs.mkdirSync(path.dirname(hook), { recursive: true });
      fs.writeFileSync(hook, '#!/bin/sh\necho "Richtlinie des Servers: Commits brauchen eine Ticketnummer."\nexit 1\n', { mode: 0o755 });
      await t.refresh(repo.repoId);
      try {
        await t.toolButton("Push").click();
        const seen = await t.until(async () => ({ dialog: await t.dialogTitle(), toasts: await t.toasts() }), (state) => state.dialog !== null || state.toasts.some((toast) => toast.tone === "danger"), 60_000);
        const dialogText = seen.actual.dialog ? (await page.locator('[role="dialog"]').last().innerText()).replace(/\s+/g, " ") : "";
        const all = `${dialogText} ${seen.actual.toasts.map((toast) => toast.text).join(" ")}`;
        await t.shot("target/e2e/bugs/C-04.png");
        // Current detour: "Show output" shows what the server wrote.
        const more = page.locator("[data-toast]").getByRole("button", { name: "Show output" });
        if ((await more.count()) > 0) {
          await more.first().click();
          const output = await t.waitDialog(/./);
          check(/Richtlinie des Servers/.test(await output.innerText()), "\"Show output\" contains the server's reason");
          await page.keyboard.press("Escape");
          await t.noDialog();
        }
        check(/Richtlinie des Servers: Commits brauchen eine Ticketnummer/.test(all), `the server's reason is in the message: ${all.slice(0, 400)}`);
        equal(remoteHead(), before, "git (bare): the remote is unchanged");
        equal(head(repo), local, "git: the local commit is intact");
        check(!/The remote contains commits that are missing locally/.test(all), "the app does not claim the remote has foreign commits (not true here)");
        check(!/Pull first/.test(dialogText), `the app does not offer "Pull first" – there is nothing to pull: ${dialogText.slice(0, 300)}`);
      } finally {
        fs.rmSync(hook, { force: true });
      }
    },
    { bug: "C-04" },
  );
  await level();

  // ---------------------------------------------------------------------------------------------
  await section(["F06-N3"], "Deleted ref: the upstream branch has vanished from the remote – Pull explains it and offers \"Set upstream\"", async () => {
    gitRaw(repo, ["checkout", "-q", "feature/export"]);
    remoteGit(repo, "update-ref", "-d", "refs/heads/feature/export");
    gitRaw(repo, ["fetch", "-q", "--prune", "origin"]);
    await t.refresh(repo.repoId);
    await eventually(() => t.leftRow("refs/heads/feature/export").locator("[data-upstream-gone]").count(), 1, "left panel: the branch carries the \"upstream no longer exists\" marker");
    const state = await t.toolState("Pull");
    if (state.disabled) {
      check(/[Uu]pstream/.test(await t.toolHint("Pull")), `Pull is disabled and names the missing upstream: ${await t.toolHint("Pull")}`);
    } else {
      await t.toolButton("Pull").click();
      const warned = await t.waitToast(/Pull: no upstream|[Uu]pstream/, null, 60_000);
      check(/deleted|doesn’t exist|no longer exists|no upstream/.test(warned?.text ?? ""), `the message explains the missing upstream: ${warned?.text}`);
      check(!/fatal:|[Ee]xit code/.test(warned?.text ?? ""), "… in its own words");
    }
    equal(currentBranch(repo), "feature/export", "git: nothing changed");
    equal(porcelain(repo), [], "git: clean");
    await t.closeToasts();
    // Push creates the branch again – after asking where to.
    const local = head(repo);
    await t.toolButton("Push").click();
    const seen = await t.until(async () => ({ dialog: await t.dialogTitle(), toasts: await t.toasts() }), (value) => value.dialog !== null || value.toasts.length > 0, 60_000);
    if (seen.actual.dialog === "Where to push?") await page.keyboard.press("Enter");
    await t.waitToast(/Pushed/, "success", 60_000);
    equal(remoteHead("feature/export"), local, "git (bare): the branch is on the remote again");
    await eventually(() => t.leftRow("refs/heads/feature/export").locator("[data-upstream-gone]").count(), 0, "left panel: the marker is gone");
    await t.closeToasts();
  });
  await level();

  // ---------------------------------------------------------------------------------------------
  await section(["F06-E19"], "Several remotes – keyboard only: \"Where to push?\" asks for the remote, arrow key picks the second", async () => {
    const mirror = path.join(repo.root, "spiegel.git");
    gitRaw(repo, ["clone", "-q", "--bare", repo.remotePath, mirror], { cwd: repo.root });
    gitRaw(repo, ["remote", "add", "spiegel", mirror]);
    gitRaw(repo, ["checkout", "-q", "-b", "thema/zwei-ziele", "main"]);
    const sha = commit(repo, "zwei.txt", "x\n", "Commit für den Spiegel");
    await t.refresh(repo.repoId);
    await t.blur();
    await page.keyboard.press("Control+Shift+P");
    const dialog = await t.waitDialog(/^Where to push\?$/);
    const group = dialog.getByRole("radiogroup", { name: "Remote" });
    equal(await group.getByRole("radio").count(), 2, "both remotes are offered (radio group \"Remote\")");
    equal(await group.getByRole("radio", { checked: true }).innerText().then((text) => text.split(/\s/)[0]), "origin", "origin is preselected");
    // From the name field back to the radio group, arrow down picks "spiegel", Enter in the name field pushes.
    await page.keyboard.press("Shift+Tab");
    equal((await t.focused()).role, "radio", "Shift+Tab goes from the name field to the radio group");
    await page.keyboard.press("ArrowDown");
    equal(await group.getByRole("radio", { checked: true }).innerText().then((text) => text.split(/\s/)[0]), "spiegel", "arrow down picks \"spiegel\"");
    check((await dialog.innerText()).includes("spiegel/thema/zwei-ziele"), "the dialog names what will be created");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await t.waitToast(/Pushed to spiegel\/thema\/zwei-ziele/, "success", 60_000);
    equal(gitRaw(repo, ["--git-dir", mirror, "rev-parse", "refs/heads/thema/zwei-ziele"]), sha, "git (bare, spiegel): the branch is on the second remote");
    equal(remoteHas("thema/zwei-ziele"), false, "git (bare, origin): it is not on origin");
    equal(upstreamOf("thema/zwei-ziele"), "spiegel/thema/zwei-ziele", "git: the upstream points to the chosen remote");
    await t.closeToasts();
    gitRaw(repo, ["checkout", "-q", "main"]);
    gitRaw(repo, ["remote", "remove", "spiegel"]);
    await page.evaluate((id) => window.__gc.queryClient.invalidateQueries({ queryKey: ["repo", id, "remotes"] }), repo.repoId);
  });
  await level();

  // ---------------------------------------------------------------------------------------------
  await section(["F06-N5"], "Wrong credentials on push (local test server): clear error, nothing pushed; with the right credentials the commit arrives", async () => {
    server = await startGitHttpServer({ users: { lena: "geheim" } });
    server.createBare("abgleich.git", { from: repo.remotePath });
    const good = gitRaw(repo, ["remote", "get-url", "origin"]);
    const local = commit(repo, "geheim.txt", "x\n", "Commit für den geschützten Server");
    gitRaw(repo, ["remote", "set-url", "origin", server.url("abgleich.git")]);
    await t.refresh(repo.repoId);
    try {
      const serverHead = () => server.git("abgleich.git", "rev-parse", "refs/heads/main");
      const before = serverHead();
      await t.toolButton("Push").click();
      await t.waitDialog(/^Username for the remote$/, 60_000);
      await page.keyboard.type("lena");
      await page.keyboard.press("Enter");
      const password = await t.waitDialog(/^Sign in to the remote$/, 60_000);
      equal(await password.getByLabel("Password or token").getAttribute("type"), "password", "the password is entered masked");
      await page.keyboard.type("falsch-geraten");
      await page.keyboard.press("Enter");
      const failed = await t.waitToast(/Push failed/, "danger", 90_000);
      check(/signing in|sign in|credentials|username|password/i.test(failed?.text ?? ""), `the message explains the failed sign-in: ${failed?.text}`);
      check(!/falsch-geraten/.test(JSON.stringify(await t.toasts())), "the entered password is in no toast");
      equal(serverHead(), before, "server: nothing was pushed");
      equal(head(repo), local, "git: the local commit is intact");
      await t.noDialog("no prompt stays open");
      equal(await page.evaluate(() => window.__gc.store.getState().credentialQueue.length), 0, "the prompt queue is empty");
      await t.closeToasts();
      await app.settle();
      await t.toolButton("Push").click();
      await t.waitDialog(/^Username for the remote$/, 60_000);
      await page.keyboard.type("lena");
      await page.keyboard.press("Enter");
      await t.waitDialog(/^Sign in to the remote$/, 60_000);
      await page.keyboard.type("geheim");
      await page.keyboard.press("Enter");
      await t.waitToast(/Pushed/, "success", 90_000);
      equal(serverHead(), local, "server: with the right credentials the commit is on the server");
      check(server.requests.some((entry) => entry.rejected === "lena"), "the server saw and rejected the wrong attempt");
      const log = await app.invoke("activity_list", { scope: "repo", repoId: repo.repoId, cursor: null, limit: 40 });
      check(!/falsch-geraten|geheim(?!\.txt)/.test(JSON.stringify(log.entries).replaceAll("geschützten", "")), "no password in the activity log");
    } finally {
      gitRaw(repo, ["remote", "set-url", "origin", good]);
      await app.invoke("credentials_forget_all").catch(() => undefined);
    }
    await t.closeToasts();
    gitRaw(repo, ["push", "-q", "origin", "main"]);
  });
  await level();

  // ---------------------------------------------------------------------------------------------
  await section(["F06-E17"], "Minimum window 960×600: Pull, Push and Fetch with counters are visible; \"Push rejected\" fits the window", async () => {
    const remoteSha = repo.commitOnRemote({ file: "docs/klein.md", message: "Für das kleine Fenster" });
    commit(repo, "klein.txt", "x\n", "Lokal, im kleinen Fenster");
    gitRaw(repo, ["fetch", "-q", "origin"]);
    await t.refresh(repo.repoId);
    await app.setSize(960, 600);
    try {
      for (const name of ["Pull", "Push", "Fetch"]) check(await t.inViewport(t.toolButton(name)), `${name} is visible at 960 px`);
      equal(await pullLabel(), "Pull, 1 commit to pull", "Pull carries the counter");
      equal(await pushLabel(), "Push, 1 commit to push", "Push carries the counter");
      equal(await t.overflow(), { x: 0, y: 0 }, "no page overflow");
      await t.toolButton("Push").click();
      const dialog = await t.waitDialog(/^Push rejected$/, 60_000);
      check(await t.inViewport(dialog), "the \"Push rejected\" dialog is fully inside the window");
      for (const name of [/^Pull first/, /^Force push/, /^Cancel$/]) check(await t.inViewport(dialog.getByRole("button", { name })), `the button ${name} is visible`);
      equal(await t.axe('[role="dialog"]'), [], "axe: no violations in the \"Push rejected\" dialog");
      await page.keyboard.press("Escape");
      await t.noDialog();
      equal(remoteHead(), remoteSha, "git (bare): nothing pushed");
    } finally {
      await app.setSize(1440, 900);
    }
    await t.closeToasts();
  });
  await level();

  // ---------------------------------------------------------------------------------------------
  await section(["F06-E18"], "Screen reader: counters and states of Pull/Push/Fetch as text; \"Where to push?\" with roles and names; axe without violations", async () => {
    commit(repo, "sr.txt", "x\n", "Für den Screenreader");
    repo.commitOnRemote({ file: "docs/sr.md", message: "Vom Remote, für den Screenreader" });
    gitRaw(repo, ["fetch", "-q", "origin"]);
    await t.refresh(repo.repoId);
    equal(await pullLabel(), "Pull, 1 commit to pull", "Pull: the counter is in the button's name (aria-label)");
    equal(await pushLabel(), "Push, 1 commit to push", "Push: the counter is in the button's name");
    check((await t.toolHint("Pull")).length > 10 && (await t.toolHint("Fetch")).length > 10, "Pull and Fetch have a description (aria-describedby)");
    equal(await page.locator("footer").getByLabel("1 commit ahead").count(), 1, "status bar: \"1 commit ahead\" as text");
    equal(await page.locator("footer").getByLabel("1 commit behind").count(), 1, "status bar: \"1 commit behind\" as text");
    equal(await page.getByRole("button", { name: "Pull: options" }).count(), 1, "the arrow next to Pull has a name");
    // label-content-name-mismatch is off: the rule counts the screen-reader-only hint in the button as visible text.
    equal(await t.axe('[role="toolbar"][aria-label="Repository actions"]', { disable: ["color-contrast", "label-content-name-mismatch"] }), [], "axe: no violations in the toolbar");
    // Disabled button: the reason is attached to the button as its description.
    gitRaw(repo, ["checkout", "-q", "--detach"]);
    await t.refresh(repo.repoId);
    check((await t.toolState("Pull")).disabled && /No branch checked out/.test(await t.toolHint("Pull")), `detached HEAD: Pull is disabled (aria-disabled) and names the reason: ${await t.toolHint("Pull")}`);
    gitRaw(repo, ["checkout", "-q", "-b", "thema/vorlesen"]);
    await t.refresh(repo.repoId);
    await t.toolButton("Push").focus();
    check((await t.focused()).visible, "the focus on \"Push\" is visible");
    await page.keyboard.press("Enter");
    const dialog = await t.waitDialog(/^Where to push\?$/);
    const named = await dialog.evaluate((node) => ({ name: document.getElementById(node.getAttribute("aria-labelledby") ?? "")?.textContent ?? null, described: Boolean(document.getElementById(node.getAttribute("aria-describedby") ?? "")?.textContent) }));
    equal(named, { name: "Where to push?", described: true }, "the dialog has a name and a description");
    equal(await page.getByRole("textbox", { name: "Branch name on the remote" }).count(), 1, "the field can be found by role and name");
    check((await t.focused()).visible, "the focus in the field is visible");
    equal(await t.axe('[role="dialog"]'), [], "axe: no violations in the dialog");
    await page.keyboard.press("Escape");
    await t.noDialog();
    gitRaw(repo, ["checkout", "-q", "main"]);
    gitRaw(repo, ["branch", "-D", "thema/vorlesen"]);
  });
  await level();

  // ---------------------------------------------------------------------------------------------
  await section(["F06-E13"], "Restart the app midway: running fetch, then pull with conflict – after the restart no lock, the merge is still in progress and can be aborted", async () => {
    const dataDir = t.tempDataDir();
    const fresh = t.made(make(() => makeCleanRepoWithRemote({ name: "neustart-sync" })));
    const main = t.app;
    let first = null;
    let again = null;
    const reopen = async () => {
      const started = await t.launch({ dataDir });
      const tab = (await started.invoke("tabs_list")).find((item) => item.kind === "repo");
      check(Boolean(tab), "after the restart the repository's tab is back");
      if (tab && !tab.isActive) await started.invoke("tab_activate", { tabId: tab.id });
      await started.page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "tabs"] }));
      await started.settle().catch(() => undefined);
      return started;
    };
    try {
      first = await t.launch({ dataDir });
      await t.open(fresh);
      // 1. A fetch that would take 40 seconds – the app is closed midway.
      const remoteSha = fresh.commitOnRemote({ file: "stationen.csv", content: "kürzel;name;höhe_m\nN;Schule Nord (Remote);41\n", message: "Stationen vom Remote geändert" });
      gitRaw(fresh, ["config", "remote.origin.uploadpack", "sleep 40; git-upload-pack"]);
      await t.toolButton("Fetch").click();
      await eventually(() => t.toolState("Fetch").then((state) => state.busy), true, "the fetch is running");
      await first.close();
      gitRaw(fresh, ["config", "--unset", "remote.origin.uploadpack"]);
      again = await reopen();
      await eventually(() => t.toolState("Fetch").then((state) => state.busy), false, "after the restart no fetch is running", 30_000);
      equal(await progress(), 0, "the status bar shows no hanging job");
      check(!fs.existsSync(path.join(fresh.path, ".git", "index.lock")), "no lock file is left behind");
      await t.toolButton("Fetch").click();
      await t.waitToast(/Fetch complete/, "success", 90_000);
      equal(gitRaw(fresh, ["rev-parse", "origin/main"]), remoteSha, "git: the fetch after the restart gets the commit");
      await t.closeToasts();
      // 2. Pull with conflict, then restart: the merge is still in progress.
      commit(fresh, "stationen.csv", "kürzel;name;höhe_m\nN;Schule Nord (lokal);41\n", "Stationen lokal geändert");
      await eventually(() => t.toolState("Pull").then((state) => state.label), "Pull, 1 commit to pull", "Pull is ready", 25_000);
      await again.settle().catch(() => undefined);
      await t.toolButton("Pull").click();
      await t.waitToast(/Pull: conflict in one file/, "warning", 90_000);
      check(porcelain(fresh).includes("UU stationen.csv"), "git: the conflict is in the working directory");
      await again.close();
      again = await reopen();
      await eventually(t.footer, (text) => /merge in progress/i.test(text), "after the restart the status bar shows the running merge", 30_000);
      check((await t.toolState("Pull")).disabled && (await t.toolState("Push")).disabled, "Pull and Push are disabled during the merge");
      check(porcelain(fresh).includes("UU stationen.csv"), "git: the conflict is still there unchanged");
      await t.runCommand("operation.abort");
      await (await t.waitDialog(/^Abort merge\?$/)).getByRole("button", { name: "Abort merge" }).click();
      await eventually(() => porcelain(fresh), [], "the merge can be aborted after the restart; the working directory is clean");
      await eventually(t.footer, (text) => !/merge in progress/i.test(text), "the status bar shows no merge any more");
      check(readFile(fresh, "stationen.csv").includes("(lokal)"), "the local version is intact");
    } finally {
      await first?.close().catch(() => undefined);
      await again?.close().catch(() => undefined);
      t.attach(main);
    }
  });
} catch (error) {
  t.check(false, `Aborted outside a section: ${error?.stack ?? error}`);
  t.results.push({ ids: ["F06"], title: "Aborted outside a section", ok: false, bug: null, seconds: "0" });
}
if (server) await server.close().catch(() => undefined);
await t.end();
