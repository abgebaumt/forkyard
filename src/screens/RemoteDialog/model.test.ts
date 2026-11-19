import { describe, expect, it } from "vitest";
import { t } from "../../i18n";
import { checkName, checkUrl, detectHost } from "./model";

describe("host badge from the remote URL", () => {
  it("recognises the big hosts in every URL form", () => {
    expect(detectHost("https://github.com/anna/wetter.git")).toEqual({ kind: "github", label: "GitHub" });
    expect(detectHost("git@gitlab.com:anna/wetter.git")).toEqual({ kind: "gitlab", label: "GitLab" });
    expect(detectHost("ssh://git@bitbucket.org:22/anna/wetter")).toEqual({ kind: "bitbucket", label: "Bitbucket" });
    expect(detectHost("https://dev.azure.com/org/p/_git/r")).toEqual({ kind: "azure", label: "Azure DevOps" });
  });

  it("names other servers and local paths; no host without a dot", () => {
    expect(detectHost("https://git.example.test/a.git")).toEqual({ kind: "other", label: "git.example.test" });
    expect(detectHost("/srv/git/a.git")?.kind).toBe("local");
    expect(detectHost("C:\\repos\\a")?.kind).toBe("local");
    expect(detectHost("file:///srv/a")?.kind).toBe("local");
    expect(detectHost("myhost:repo")).toBeNull();
    expect(detectHost("  ")).toBeNull();
  });
});

describe("remote checks", () => {
  it("checks the name", () => {
    expect(checkName("", [])).toBe(t("remotes.validation.nameMissing"));
    expect(checkName("my remote", [])).toBe(t("remotes.validation.nameSpaces"));
    expect(checkName("a..b", [])).toBe(t("remotes.validation.nameChars"));
    expect(checkName("a.lock", [])).toBe(t("remotes.validation.nameEdges"));
    expect(checkName("origin", ["origin"])).toBe(t("remotes.validation.nameExists", { name: "origin" }));
    expect(checkName("upstream", ["origin"])).toBeNull();
  });

  it("checks the URL; spaces only in local paths", () => {
    expect(checkUrl("")).toBe(t("remotes.validation.urlMissing"));
    expect(checkUrl("https://github.com/a b")).toBe(t("remotes.validation.urlSpaces"));
    expect(checkUrl("/home/anna/mein repo")).toBeNull();
  });
});
