import { describe, expect, it } from "vitest";
import { t } from "../../i18n";
import { dashed, kindLabels, mainChoice, setupBlocked, startBlocked } from "./model";

const prefixes = { feature: "feature/", release: "release/", hotfix: "hotfix/", versionTag: "v" };

describe("Gitflow setup", () => {
  it("keeps the chosen main branch while it exists, else the checked-out or first one", () => {
    expect(mainChoice(["main", "dev"], "dev", "main", "main")).toEqual({ options: ["main", "dev"], value: "main" });
    expect(mainChoice(["trunk", "dev"], "dev", "main", "main").value).toBe("dev");
    expect(mainChoice(["trunk", "dev"], undefined, "main", "main").value).toBe("trunk");
    expect(mainChoice([], undefined, "x", "master")).toEqual({ options: ["master"], value: "master" });
  });

  it("needs develop, different from main, and distinct non-empty prefixes", () => {
    expect(setupBlocked("develop", "main", prefixes)).toEqual({ developError: null, prefixError: null, blocked: null });
    expect(setupBlocked("", "main", prefixes).blocked).toBe(t("gitflow.setup.developMissing"));
    expect(setupBlocked("main", "main", prefixes).blocked).toBe(t("gitflow.setup.sameBranch"));
    expect(setupBlocked("develop", "main", { ...prefixes, release: " " }).prefixError).toBe(
      t("gitflow.setup.prefixMissing", { kind: kindLabels.release }),
    );
    expect(setupBlocked("develop", "main", { ...prefixes, hotfix: "feature/" }).blocked).toBe(t("gitflow.setup.prefixDuplicate"));
  });

  it("types dashes instead of spaces", () => expect(dashed("neue karte")).toBe("neue-karte"));
});

describe("Gitflow start", () => {
  const ok = { ready: true, operation: false, running: undefined, kind: "feature" as const, name: "karte", reason: null };

  it("checks setup, a running operation, a running release and the name in this order", () => {
    expect(startBlocked(ok)).toBeNull();
    expect(startBlocked({ ...ok, ready: false, operation: true })).toBe(t("gitflow.start.notReady"));
    expect(startBlocked({ ...ok, operation: true })).toBe(t("gitflow.start.operation"));
    const running = { kind: "release" as const, name: "1.2", branch: "release/1.2" };
    expect(startBlocked({ ...ok, kind: "release", running })).toBe(
      t("gitflow.start.running", { kind: kindLabels.release, name: "1.2", branch: "release/1.2" }),
    );
    expect(startBlocked({ ...ok, name: "  " })).toBe(t("gitflow.start.nameMissing"));
    expect(startBlocked({ ...ok, reason: "bad" })).toBe("bad");
  });
});
