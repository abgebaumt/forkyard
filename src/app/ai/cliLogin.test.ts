import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../../core";

let tabs: Tab[] = [];
const opened: { tabId: string; repoId: string; title: string }[] = [];
const logins: unknown[] = [];
const shown: string[] = [];
let closed = 0;

vi.mock("../queries", () => ({ qk: { tabs: ["app", "tabs"] }, queryClient: { getQueryData: () => tabs } }));
vi.mock("../store", () => ({
  useAppStore: {
    getState: () => ({
      closeOverlay: () => {
        closed += 1;
      },
    }),
  },
}));
vi.mock("../../screens/Terminal/sessions", () => ({
  openProgramSession: (tabId: string, repoId: string, title: string, open: (size: { cols: number; rows: number }) => Promise<string>) => {
    opened.push({ tabId, repoId, title });
    void open({ cols: 120, rows: 30 });
    return {};
  },
}));
vi.mock("../../screens/Terminal/actions", () => ({ showTerminal: (tabId: string) => shown.push(tabId) }));
vi.mock("../../core", () => ({
  core: {
    aiCliLogin: (input: unknown) => {
      logins.push(input);
      return Promise.resolve("terminal-1");
    },
  },
}));

const { signInInTerminal } = await import("./cliLogin");

const tab = (patch: Partial<Tab>): Tab => ({ id: "tab-1", kind: "repo", repoId: "repo-1", position: 1, isActive: true, title: "Mein Projekt", path: "/home/lena/Mein Projekt", ...patch });

beforeEach(() => {
  tabs = [];
  opened.length = 0;
  logins.length = 0;
  shown.length = 0;
  closed = 0;
});

describe("sign in in the terminal", () => {
  it("needs an open repository tab; without one the dialog shows the command as text", () => {
    tabs = [tab({ id: "start", kind: "management", repoId: null, title: "", path: null })];
    expect(signInInTerminal("claude_code")).toBe(false);
    tabs = [tab({ isActive: false })];
    expect(signInInTerminal("claude_code")).toBe(false);
    expect(opened).toEqual([]);
    expect(logins).toEqual([]);
  });

  it("opens a terminal tab in the active repository tab and shows it, after closing the settings", () => {
    tabs = [tab({ id: "other", repoId: "repo-0", isActive: false }), tab({})];
    expect(signInInTerminal("codex")).toBe(true);
    expect(opened).toEqual([{ tabId: "tab-1", repoId: "repo-1", title: "Codex" }]);
    expect(logins).toEqual([{ repoId: "repo-1", provider: "codex", cols: 120, rows: 30 }]);
    expect(shown).toEqual(["tab-1"]);
    expect(closed).toBe(1);
  });
});
