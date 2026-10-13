/**
 * network – Network: proxy, custom CA bundle and certificate verification turned off per host – in the
 * real app against a real HTTPS Git server with a self-signed certificate and a real proxy (both
 * run in this script on 127.0.0.1).
 *
 *   node scripts/e2e/screens/proxy.mjs                 everything (checks and screenshots)
 *   node scripts/e2e/screens/proxy.mjs --only proxy    only sections whose title contains "proxy" (comma separates several)
 *   node scripts/e2e/screens/proxy.mjs --show          window visible
 *
 * Whether a setting works is shown by the fetch: a new commit is created on the server first; if it
 * arrives locally (git rev-parse origin/main), the connection worked. The proxy records who wants to
 * go through it. The "keyboard only" section does not use the mouse.
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { startGitHttpServer } from "../git-http-server.mjs";
import { SHOTS, closeToasts, finish, makeChecks, makeDriver } from "./files-lib.mjs";
import { pageHelpers } from "./prefs-lib.mjs";

process.env.GIT_OPTIONAL_LOCKS = "0";

const show = process.argv.includes("--show");
const checks = makeChecks("proxy");
const { check, equal, eventually, until, section, state } = checks;
state.only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;

const USER = "lena";
const PASSWORD = "geheim";
const repo = makeCleanRepoWithRemote({ name: "netz" });
const server = await startGitHttpServer({ users: { [USER]: PASSWORD }, tls: true });
server.createBare("messnetz.git", { from: repo.path });
const serverUrl = new URL(server.url("messnetz.git"));
const hostPort = serverUrl.host; // 127.0.0.1:<port>
const withLogin = (host) => `https://${USER}:${PASSWORD}@${host}/messnetz.git`;
repo.git("remote", "set-url", "origin", withLogin(hostPort));

/** A simple HTTP proxy (CONNECT) that records where it is asked to connect. */
const proxyConnects = [];
const proxy = http.createServer((request, response) => {
  response.writeHead(405);
  response.end();
});
proxy.on("connect", (request, client, head) => {
  proxyConnects.push(request.url);
  const [host, port] = request.url.split(":");
  const upstream = net.connect(Number(port), host, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

let serverCommits = 0;
/** New commit in the repository on the server (no network, directly in the bare repository). Returns the SHA. */
const commitOnServer = () => {
  serverCommits += 1;
  const tree = server.git("messnetz.git", "rev-parse", "main^{tree}");
  const parent = server.git("messnetz.git", "rev-parse", "main");
  const commit = server.git("messnetz.git", "-c", "user.name=Jonas Albrecht", "-c", "user.email=jonas.albrecht@wetterstation.example", "commit-tree", tree, "-p", parent, "-m", `Nachtrag ${serverCommits} auf dem Server`);
  server.git("messnetz.git", "update-ref", "refs/heads/main", commit);
  return commit;
};
const localRemoteMain = () => repo.git("rev-parse", "refs/remotes/origin/main");
const samePath = (a, b) => (a ?? "").replaceAll("\\", "/").toLowerCase() === (b ?? "").replaceAll("\\", "/").toLowerCase();

const PREFS = '[data-screen="settings"]';
const NET = '[data-screen="network"]';

let app = null;
try {
  // The machine's environment must not interfere: with NO_PROXY=127.0.0.1 Git would skip the proxy for
  // the test server, with HTTPS_PROXY a foreign one would be added. So the app starts without these variables.
  const noProxyEnv = Object.fromEntries(["NO_PROXY", "no_proxy", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"].map((name) => [name, ""]));
  app = await launchApp({ show, env: noProxyEnv });
  state.app = app;
  const { page } = app;
  const h = pageHelpers(app);
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
  const { repoId, tabId } = await app.openRepo(repo.path);
  const ui = makeDriver(app, tabId, checks);
  const settings = () => app.invoke("settings_get");
  const setSettings = async (patch) => {
    await app.invoke("settings_set", { patch });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "settings"] }));
    await app.settle();
  };
  const prefs = page.locator(PREFS);
  const net = page.locator(NET);
  const row = (title) => net.locator(`[data-setting="${title}"]`);
  const toasts = () => page.locator("[data-toast]").evaluateAll((list) => list.map((item) => ({ tone: item.getAttribute("data-toast"), text: item.innerText.replace(/\s+/g, " ").trim() })));
  const openNetwork = async ({ keyboard = false } = {}) => {
    await page.keyboard.press("Control+,");
    await prefs.waitFor();
    const selected = () => page.getByRole("tab", { selected: true }).innerText();
    if (keyboard) {
      for (let step = 0; step < 14; step++) {
        const now = await selected();
        if (now === "Network") break;
        await page.keyboard.press("ArrowDown");
        await page.waitForFunction((before) => document.querySelector('[data-screen="settings"] [role="tab"][aria-selected="true"]')?.textContent?.trim() !== before, now, { timeout: 5000 }).catch(() => undefined);
      }
    } else {
      await page.getByRole("tab", { name: "Network", exact: true }).click();
    }
    await eventually(selected, "Network", "section \"Network\" is open");
    await net.waitFor();
    await app.settle();
  };
  const closePrefs = async () => {
    await page.keyboard.press("Escape");
    await eventually(() => prefs.count(), 0, "preferences closed");
  };
  const shot = async (name) => {
    await app.settle();
    await page.waitForTimeout(250);
    await app.screenshot(`${SHOTS}/${name}.png`);
  };
  /**
   * Creates a commit on the server and gets it with the "Fetch" command (through the palette,
   * keyboard only). Returns { arrived, toast }: whether the commit arrived locally, and the app's toast.
   */
  const fetchNow = async () => {
    await closeToasts(page);
    const wanted = commitOnServer();
    await ui.runCommand("fetch", "sync.fetch");
    await until(async () => (await toasts()).some((toast) => /Fetch/.test(toast.text)), "toast for the fetch", 60_000);
    await app.settle();
    const shown = (await toasts()).find((toast) => /Fetch/.test(toast.text));
    return { arrived: localRemoteMain() === wanted, toast: shown, wanted };
  };
  state.resetView = async () => {
    for (let round = 0; round < 4 && (await page.locator('[role="dialog"], [role="alertdialog"], [role="menu"]').count()) > 0; round++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
    }
    await closeToasts(page);
    await app.settle();
  };

  // -------------------------------------------------------------------------------------------
  await section("Initial state: nobody trusts the self-signed certificate – the fetch fails", async () => {
    const start = await settings();
    equal([start.proxyUrl ?? null, start.proxyByHost ?? [], start.sslCaFile ?? null, start.sslNoVerifyHosts ?? []], [null, [], null, []], "initial state: no proxy, no CA bundle, no exception");
    const result = await fetchNow();
    equal(result.arrived, false, "without trust the new commit does not arrive");
    equal(result.toast?.tone, "danger", "the app reports the failure");
    if (!/[Cc]ertificate/.test(result.toast?.text ?? "")) {
      // The core classifies Git's certificate error as "unreachable" – the UI shows what it reports.
      checks.measurements.push(`CORE (not worked around): the core reports an untrusted certificate as "${result.toast?.text}" – the certificate as the reason is missing from the message (Git itself names it).`);
      console.log("  ! Core: certificate error is reported as \"server unreachable\"");
    }
    const log = await app.invoke("activity_list", { scope: "repo", repoId, cursor: null, limit: 3 });
    check(log.entries.some((entry) => /certificate|UNTRUSTED_ROOT/i.test(entry.output)), "the activity log holds Git's output naming the certificate as the reason");
    await shot("network-cert-error");
  });

  // -------------------------------------------------------------------------------------------
  await section("Custom CA bundle – entered keyboard only: the fetch works", async () => {
    await openNetwork({ keyboard: true });
    check((await net.innerText()).includes("The certificate is verified for every host."), "empty state: every connection is verified");
    check((await net.innerText()).includes("No exceptions: the proxy above applies to every host."), "empty state: no proxy exceptions");
    equal(await net.locator("[data-network-warning]").count(), 0, "no warning as long as nothing is turned off");
    await shot("network-empty");

    await h.tabTo("Custom CA bundle");
    await page.keyboard.insertText(path.join(repo.root, "gibt-es-nicht.pem"));
    await page.keyboard.press("Enter");
    await until(async () => (await row("Custom CA bundle").getByRole("alert").allInnerTexts()).join(" ").includes("not found"), "a missing file is reported at the field");
    equal((await settings()).sslCaFile ?? null, null, "and not saved");
    equal((await toasts()).filter((toast) => toast.tone === "danger"), [], "without an extra error toast");
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText(server.caFile);
    await page.keyboard.press("Enter");
    await eventually(async () => samePath((await settings()).sslCaFile, server.caFile), true, "the CA bundle is saved (settings_get)");
    await closePrefs();

    const result = await fetchNow();
    equal(result.arrived, true, "with the CA bundle the commit arrives from the server (git rev-parse origin/main)");
    equal(result.toast?.tone !== "danger", true, `no error (${result.toast?.text})`);
    equal(proxyConnects.length, 0, "without a proxy setting nothing goes through the proxy");
  });

  // -------------------------------------------------------------------------------------------
  await section("Turn off certificate verification per host: confirmation, warning, applies to this host only", async () => {
    await setSettings({ sslCaFile: null, sslNoVerifyHosts: [] });
    equal((await fetchNow()).arrived, false, "without the CA bundle the fetch fails again");
    await closeToasts(page);

    await openNetwork();
    const form = net.locator('[data-network-form="no-verify"]');
    // Wildcards are rejected before any confirmation is asked.
    await form.getByRole("textbox", { name: "Host" }).fill("*");
    await form.getByRole("button", { name: "Turn off verification …" }).click();
    await until(async () => (await form.getByRole("alert").allInnerTexts()).join(" ").includes("Wildcards are not allowed"), "\"*\" is rejected at the field");
    equal(await page.getByRole("dialog", { name: /Turn off certificate verification for/ }).count(), 0, "without confirmation");

    await form.getByRole("textbox", { name: "Host" }).fill(hostPort);
    await form.getByRole("button", { name: "Turn off verification …" }).click();
    const ask = page.getByRole("dialog", { name: `Turn off certificate verification for “${hostPort}”?` });
    await ask.waitFor();
    check((await ask.innerText()).includes("capture credentials"), "the confirmation names the risk");
    check((await ask.innerText()).includes("CA bundle"), "and the safer way");
    equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Cancel", "focus is on \"Cancel\"");
    await shot("network-confirm");
    await page.keyboard.press("Enter");
    await eventually(() => ask.count(), 0, "Enter cancels");
    equal((await settings()).sslNoVerifyHosts ?? [], [], "after cancelling nothing is turned off");
    equal(await form.getByRole("textbox", { name: "Host" }).inputValue(), hostPort, "the input is still in the field");

    await form.getByRole("button", { name: "Turn off verification …" }).click();
    await ask.getByRole("button", { name: "Turn off verification", exact: true }).click();
    await eventually(async () => (await settings()).sslNoVerifyHosts ?? [], [`https://${hostPort}`], "the exception is saved – for exactly this host");
    const warning = net.locator("[data-network-warning]");
    await warning.waitFor();
    check((await warning.innerText()).startsWith("Certificate verification is turned off for 1 host"), "a warning is shown at the top of the section");
    equal(await warning.locator('[role="alert"]').count(), 1, "als role=alert");
    check((await net.locator(`[data-network-no-verify="https://${hostPort}"]`).innerText()).includes("unverified"), "the host is in the list, marked with a word");
    await row("Custom CA bundle").scrollIntoViewIfNeeded();
    await shot("network-no-verify");
    await closePrefs();

    equal((await fetchNow()).arrived, true, "for this host the fetch now works without verification");
    // The same server under another name: the exception does not apply to it.
    repo.git("remote", "set-url", "origin", withLogin(`localhost:${serverUrl.port}`));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await app.settle();
    const other = await fetchNow();
    equal(other.arrived, false, "another host (localhost instead of 127.0.0.1) is still verified");
    equal(other.toast?.tone, "danger", "and the fetch fails");
    repo.git("remote", "set-url", "origin", withLogin(hostPort));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await app.settle();
    await closeToasts(page);

    await openNetwork();
    await net.getByRole("button", { name: `Verify certificate of https://${hostPort} again` }).click();
    await eventually(async () => (await settings()).sslNoVerifyHosts ?? [], [], "\"Verify again\" removes the exception");
    await eventually(() => net.locator("[data-network-warning]").count(), 0, "the warning disappears");
    await closePrefs();
    equal((await fetchNow()).arrived, false, "afterwards the fetch fails on the certificate again");
  });

  // -------------------------------------------------------------------------------------------
  await section("Proxy: all connections go through it; exception per host; wrong address at the field", async () => {
    await setSettings({ sslCaFile: server.caFile, sslNoVerifyHosts: [], proxyUrl: null, proxyByHost: [] });
    await openNetwork();
    const field = row("Proxy").locator("input");
    await field.fill("kein proxy");
    await field.press("Enter");
    await until(async () => (await row("Proxy").getByRole("alert").allInnerTexts()).join(" ").includes("contains no spaces"), "an address with spaces is rejected at the field");
    await field.fill("proxy.firma.example");
    await field.press("Enter");
    await until(async () => (await row("Proxy").getByRole("alert").allInnerTexts()).join(" ").includes("http://proxy.company.example:8080"), "without a protocol: the field shows what it must look like");
    equal((await settings()).proxyUrl ?? null, null, "none of it is saved");
    await field.fill(proxyUrl);
    await field.press("Enter");
    await eventually(async () => (await settings()).proxyUrl, proxyUrl, "the proxy is saved");
    await closePrefs();

    proxyConnects.length = 0;
    let result = await fetchNow();
    equal(result.arrived, true, "the commit arrives through the proxy");
    check(proxyConnects.length > 0 && proxyConnects.every((target) => target === hostPort), `the proxy opened the connection to the Git server (${JSON.stringify(proxyConnects)})`);

    // A proxy that does not exist: the fetch fails – until the host gets an exception.
    await setSettings({ proxyUrl: "http://127.0.0.1:9" });
    result = await fetchNow();
    equal(result.arrived, false, "nothing arrives through an unreachable proxy");
    equal(result.toast?.tone, "danger", "the app reports the failure");
    await closeToasts(page);

    await openNetwork();
    const form = net.locator('[data-network-form="proxy-host"]');
    await form.getByRole("textbox", { name: "Host", exact: true }).fill(hostPort);
    await form.getByRole("button", { name: "Add" }).click();
    await eventually(async () => (await settings()).proxyByHost ?? [], [{ host: `https://${hostPort}`, proxy: "" }], "the exception is saved: this host without proxy");
    check((await net.locator(`[data-network-proxy-host="https://${hostPort}"]`).innerText()).includes("no proxy"), "the list shows it as text");
    await row("Proxy").scrollIntoViewIfNeeded();
    await shot("network-proxy");
    await closePrefs();
    proxyConnects.length = 0;
    result = await fetchNow();
    equal(result.arrived, true, "with the exception the connection goes direct – bypassing the broken proxy");
    equal(proxyConnects.length, 0, "and not through the proxy");

    // Exception with its own proxy: credentials in the address are not spelled out in the list.
    await openNetwork();
    await form.getByRole("textbox", { name: "Host", exact: true }).fill(hostPort);
    await form.getByRole("textbox", { name: /^Proxy for this host/ }).fill(proxyUrl.replace("http://", "http://anna:streng-geheim@"));
    await form.getByRole("button", { name: "Add" }).click();
    await until(async () => ((await settings()).proxyByHost ?? [])[0]?.proxy.includes("anna"), "the exception now has its own proxy");
    const line = await net.locator(`[data-network-proxy-host="https://${hostPort}"]`).innerText();
    check(line.includes("anna:•••@") && !line.includes("streng-geheim"), `the proxy password is not in the list (${line.replace(/\s+/g, " ")})`);
    await net.getByRole("button", { name: `Remove exception for https://${hostPort}` }).click();
    await eventually(async () => (await settings()).proxyByHost ?? [], [], "the exception can be removed");
    await closePrefs();
    await setSettings({ proxyUrl: null });
  });

  // -------------------------------------------------------------------------------------------
  await section("Many and long entries; light theme and minimum window", async () => {
    const hosts = Array.from({ length: 14 }, (_, index) => `git-${String(index + 1).padStart(2, "0")}.messnetz.example`);
    hosts.push(`ein-sehr-langer-hostname-${"abteilung-".repeat(8)}git.messnetz.example:8443`);
    await setSettings({
      proxyUrl: "http://proxy.messnetz.example:8080",
      proxyByHost: hosts.slice(0, 12).map((host, index) => ({ host, proxy: index % 3 === 0 ? "" : "http://proxy-zwei.messnetz.example:3128" })),
      sslNoVerifyHosts: hosts,
    });
    await openNetwork();
    equal((await net.locator("[data-network-no-verify]").count()) === 15 && (await net.locator("[data-network-proxy-host]").count()) === 12, true, "all entries are in the lists");
    check((await net.locator("[data-network-warning]").innerText()).startsWith("Certificate verification is turned off for 15 hosts"), "the warning counts along");
    const list = net.locator('ul[aria-label="Hosts without certificate verification"]');
    const box = await list.evaluate((element) => ({ scrolls: element.scrollHeight > element.clientHeight, wide: element.scrollWidth - element.clientWidth }));
    equal(box, { scrolls: true, wide: 0 }, "the long list scrolls within its frame, not horizontally");
    equal(await h.escaping(PREFS), [], "nothing overflows the dialog");
    await shot("network-many");
    await app.setTheme("light");
    await shot("network-many-light");
    await app.setTheme("dark");
    await app.setSize(960, 600);
    equal(await h.escaping(PREFS), [], "960×600: nothing overflows the dialog");
    await shot("network-many-min");
    await app.setSize(1440, 900);
    await closePrefs();
    await setSettings({ proxyUrl: null, proxyByHost: [], sslNoVerifyHosts: [], sslCaFile: null });
  });
} catch (error) {
  check(false, `script aborted: ${error?.stack ?? error}`);
}
proxy.close();
await server.close().catch(() => undefined);
await finish("proxy", checks, app, () => repo.cleanup());
