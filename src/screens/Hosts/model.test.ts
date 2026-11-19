import { describe, expect, it } from "vitest";
import type { HostAccountInfo, HostKind } from "../../app/hosts";
import { t } from "../../i18n";
import { instanceLabels, stateText, tokenGuides } from "./model";

const account = (patch: Partial<HostAccountInfo> = {}): HostAccountInfo => ({
  id: "acc-1",
  kind: "github",
  baseUrl: null,
  username: null,
  user: { login: "anna", name: "Anna Muster", avatarUrl: null },
  tokenHint: "abcd",
  scopesOk: true,
  missingScopes: [],
  lastError: null,
  ...patch,
});

describe("host account rows", () => {
  it("names the person when connected", () => {
    expect(stateText(account(), "ok")).toEqual({ label: t("hosts.state.connectedAs", { person: "Anna Muster" }), detail: null });
    expect(stateText(account({ user: null }), "ok").label).toBe(t("hosts.state.connected"));
  });

  it("explains missing permissions, an expired token and other errors", () => {
    expect(stateText(account({ scopesOk: false }), "scopes").detail).toBe(t("hosts.state.scopesDetailPerson", { person: "Anna Muster" }));
    expect(stateText(account({ user: null }), "expired")).toEqual({
      label: t("hosts.state.expired"),
      detail: t("hosts.state.expiredDetail"),
    });
    expect(stateText(account({ lastError: "401" }), "expired").detail).toBe("401");
    expect(stateText(account({ lastError: "offline" }), "error")).toEqual({ label: t("hosts.state.error"), detail: "offline" });
  });
});

describe("token guides", () => {
  const kinds: HostKind[] = ["github", "gitlab", "gitea", "bitbucket", "azure_devops"];

  it("every host has a path, at least one permission and its public address", () => {
    for (const kind of kinds) {
      expect(tokenGuides[kind].path.length, kind).toBeGreaterThan(1);
      expect(tokenGuides[kind].variants.flatMap((variant) => variant.permissions).length, kind).toBeGreaterThan(0);
      expect(instanceLabels[kind].public, kind).toMatch(/\.(com|org)$/);
    }
  });
});
