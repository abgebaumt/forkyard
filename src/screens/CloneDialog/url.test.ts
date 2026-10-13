import { describe, expect, it } from "vitest";
import { parseCloneUrl } from "./url";

describe("parseCloneUrl", () => {
  it("accepts the usual forms", () => {
    for (const url of [
      "https://example.org/gruppe/projekt.git",
      "git@gc-test.invalid:gruppe/projekt.git",
      "ssh://git@gc-test.invalid/gruppe/projekt.git",
      "ssh://git@gc-test.invalid:2222/gruppe/projekt.git",
      "ssh://[::1]:2222/projekt.git",
      "ssh://[::1]/projekt.git",
      "https://nutzer:geheim@example.org:8443/projekt.git",
      "C:/quellen/projekt",
      "file:///srv/git/projekt.git",
    ]) {
      expect(parseCloneUrl(url), url).toMatchObject({ ok: true });
    }
  });

  // Bug: these three were considered valid; once submitted, the error talked about the network.
  it("rejects a port that is not a number (scp colon in an ssh:// URL)", () => {
    const check = parseCloneUrl("ssh://git@gc-test.invalid:gruppe/projekt.git");
    expect(check.ok).toBe(false);
    expect(!check.ok && check.reason).toMatch(/port/);
    expect(!check.ok && check.reason).toMatch(/git@host:path/);
  });

  it("rejects a port outside 1–65535", () => {
    for (const url of ["ssh://git@gc-test.invalid:99999/projekt.git", "https://example.org:0/projekt.git"]) {
      const check = parseCloneUrl(url);
      expect(check.ok, url).toBe(false);
      expect(!check.ok && check.reason, url).toMatch(/1 and 65535/);
    }
  });

  it("rejects “ssh:/…” with only one slash", () => {
    const check = parseCloneUrl("ssh:/git@gc-test.invalid/gruppe/projekt.git");
    expect(check.ok).toBe(false);
    expect(!check.ok && check.reason).toMatch(/ssh:\/\//);
  });

  it("leaves drive letters and scp addresses with an absolute path alone", () => {
    expect(parseCloneUrl("D:/arbeit/projekt")).toMatchObject({ ok: true, kind: "local" });
    expect(parseCloneUrl("server:/srv/git/projekt.git")).toMatchObject({ ok: true, kind: "ssh", host: "server" });
  });
});
