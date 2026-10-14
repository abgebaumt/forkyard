/**
 * View state of the app (zustand). Data from the core does NOT live here but in
 * the query cache (see queries.ts). This only holds what the UI is currently
 * showing: selection, centre, panels, overlays, running jobs, prompts.
 */
import { create } from "zustand";
import type { CredentialRequest, DiffSource, Id, Sha } from "../core";

// ---------------------------------------------------------------------------
// Per-tab types
// ---------------------------------------------------------------------------

export type Selection =
  | { kind: "wip" }
  /** Selection order; the last element is the active commit. */
  | { kind: "commits"; shas: Sha[] }
  | { kind: "stash"; index: number }
  | null;

export type CommitSelection = Extract<NonNullable<Selection>, { kind: "commits" } | { kind: "stash" }>;

export type RebaseToolMode = "interactive" | "squash" | "cherry_pick";

export type CenterView =
  | { kind: "graph" }
  | { kind: "diff"; path: string; source: DiffSource }
  | { kind: "file"; path: string; sha: Sha | null; mode: "view" | "edit" }
  | { kind: "history"; path: string }
  | { kind: "blame"; path: string; sha: Sha | null }
  | { kind: "conflict"; path: string }
  | { kind: "rebase"; base: string; mode: RebaseToolMode; shas: Sha[] }
  /** `source`/`target`: preselected branches (from the branch or drop menu), otherwise the checked-out and the default branch. */
  | { kind: "pr_create"; source?: string; target?: string }
  | { kind: "pr"; number: number }
  /** Issues of the host; `number`: the opened issue, null = just the list. */
  | { kind: "issues"; number: number | null }
  /** Reflog of HEAD (`ref: null`) or of a branch (full name). */
  | { kind: "reflog"; ref: string | null };

export type RightPanel = "details" | "stash_form";

/** Search in the graph. Hits and the active hit, so the graph can highlight them. */
export interface GraphSearch {
  query: string;
  hits: Sha[];
  /** Index into `hits`, -1 = none. */
  active: number;
}

export interface TabView {
  selection: Selection;
  center: CenterView;
  rightPanel: RightPanel;
  searchOpen: boolean;
  search: GraphSearch;
  terminalOpen: boolean;
  /** Collapsed by the user. Below 1100 px the Left Panel also collapses by itself (see isLeftCollapsed). */
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  /** Request to the graph to scroll to this commit. `nonce` changes with every request. */
  /** `key`: graph row to scroll to when it is not the commit row itself (a stash row). */
  reveal: { sha: Sha; nonce: number; key?: string } | null;
}

export const defaultTabView = (): TabView => ({
  selection: { kind: "wip" },
  center: { kind: "graph" },
  rightPanel: "details",
  searchOpen: false,
  search: { query: "", hits: [], active: -1 },
  terminalOpen: false,
  leftCollapsed: false,
  rightCollapsed: false,
  reveal: null,
});

// ---------------------------------------------------------------------------
// Global types
// ---------------------------------------------------------------------------

export type PaletteMode = "all" | "commands" | "files" | "branches" | "repos";

export type PreferencesSection =
  | "general"
  | "profiles"
  | "ssh"
  | "integrations"
  | "external"
  | "commands"
  | "notifications"
  | "ui"
  | "signing"
  | "editor"
  | "terminal"
  | "repo";

export type Overlay =
  | null
  | { kind: "clone" }
  | { kind: "init" }
  | { kind: "palette"; mode: PaletteMode }
  | { kind: "preferences"; section: PreferencesSection; createProfile?: boolean }
  | { kind: "add_remote"; edit?: string }
  | { kind: "shortcuts" }
  | { kind: "activity" }
  | { kind: "add_submodule" }
  /** Git LFS for the repository in the active tab (src/screens/Lfs). */
  | { kind: "lfs" };

export interface Job {
  id: string;
  /** Title for the status bar, e.g. "Fetch origin". */
  title: string;
  repoId: Id | null;
  phase: string;
  percent: number | null;
  line: string;
  startedAt: number;
  /**
   * Aborting midway would leave something half-done (a clone): while such a job runs, the app
   * asks before the window is closed. Fetch, pull and push are not such jobs.
   */
  askBeforeQuit?: boolean;
}

// Sizes from design/tokens.json › layout
export const PANEL_LIMITS = {
  left: { default: 260, min: 180, max: 480 },
  right: { default: 380, min: 300, max: 640 },
} as const;
export const NARROW_WINDOW = 1100;

const WIDTH_KEY = "gc.panelWidths";

function loadWidths(): { left: number; right: number } {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { left?: unknown; right?: unknown };
      return {
        left: clampWidth("left", typeof parsed.left === "number" ? parsed.left : PANEL_LIMITS.left.default),
        right: clampWidth("right", typeof parsed.right === "number" ? parsed.right : PANEL_LIMITS.right.default),
      };
    }
  } catch {
    // No localStorage (private mode, test): default widths.
  }
  return { left: PANEL_LIMITS.left.default, right: PANEL_LIMITS.right.default };
}

function saveWidths(left: number, right: number) {
  try {
    localStorage.setItem(WIDTH_KEY, JSON.stringify({ left, right }));
  } catch {
    // never mind – the width then only applies until restart
  }
}

export function clampWidth(side: "left" | "right", width: number): number {
  const limits = PANEL_LIMITS[side];
  return Math.round(Math.min(limits.max, Math.max(limits.min, width)));
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface AppState {
  views: Record<Id, TabView>;
  overlay: Overlay;
  leftWidth: number;
  rightWidth: number;
  /** Window narrower than 1100 px. */
  narrow: boolean;
  /** Expanded by the user despite the narrow window. */
  narrowLeftOpen: boolean;
  /** Profile chip menu open (also from the Command Palette). */
  profileMenuOpen: boolean;
  jobs: Record<string, Job>;
  credentialQueue: CredentialRequest[];
  /** Running actions (keys from runAction › busyKey), so buttons stay disabled until the answer arrives. */
  busy: Record<string, true>;
  /** Time of the last successful fetch per repository (ms since epoch). */
  lastFetch: Record<Id, number>;

  // --- per tab ---
  selectWip(tabId: Id): void;
  /** Replaces the selection. Multi-selection: pass all SHAs in click order. */
  selectCommits(tabId: Id, shas: Sha[]): void;
  /** Ctrl+click: add or remove a SHA. */
  toggleCommit(tabId: Id, sha: Sha): void;
  /** With `sha` the graph also scrolls to the stash row. */
  selectStash(tabId: Id, index: number, sha?: Sha): void;
  clearSelection(tabId: Id): void;
  /** Selects the commit and asks the graph to scroll there. */
  revealCommit(tabId: Id, sha: Sha): void;

  setCenter(tabId: Id, center: CenterView): void;
  openDiff(tabId: Id, path: string, source: DiffSource): void;
  openFile(tabId: Id, path: string, sha: Sha | null, mode?: "view" | "edit"): void;
  openHistory(tabId: Id, path: string): void;
  openBlame(tabId: Id, path: string, sha: Sha | null): void;
  openConflict(tabId: Id, path: string): void;
  openRebase(tabId: Id, base: string, mode: RebaseToolMode, shas?: Sha[]): void;
  /** Reflog of HEAD (`ref: null`) or a branch (`refs/heads/…`, `refs/remotes/…`). */
  openReflog(tabId: Id, ref: string | null): void;
  /** Back to the graph. */
  closeCenter(tabId: Id): void;

  setRightPanel(tabId: Id, panel: RightPanel): void;
  openStashForm(tabId: Id): void;

  setSearchOpen(tabId: Id, open: boolean): void;
  toggleSearch(tabId: Id): void;
  setSearch(tabId: Id, patch: Partial<GraphSearch>): void;
  toggleTerminal(tabId: Id): void;
  toggleLeftPanel(tabId: Id): void;
  toggleRightPanel(tabId: Id): void;
  setLeftCollapsed(tabId: Id, collapsed: boolean): void;
  setRightCollapsed(tabId: Id, collapsed: boolean): void;
  /** Discard the state of a closed tab. */
  dropTabView(tabId: Id): void;

  // --- global ---
  openOverlay(overlay: NonNullable<Overlay>): void;
  setProfileMenuOpen(open: boolean): void;
  closeOverlay(): void;
  setLeftWidth(width: number): void;
  setRightWidth(width: number): void;
  setNarrow(narrow: boolean): void;

  startJob(job: { id: string; title: string; repoId: Id | null; askBeforeQuit?: boolean }): void;
  updateJob(update: { jobId: string; repoId: Id | null; phase: string; percent: number | null; line: string }): void;
  finishJob(jobId: string): void;

  enqueueCredential(request: CredentialRequest): void;
  /** Removes the answered prompt from the queue. */
  resolveCredential(requestId: string): void;

  setBusy(key: string, busy: boolean): void;
  markFetched(repoId: Id, at?: number): void;
}

const initialWidths = loadWidths();

export const useAppStore = create<AppState>()((set, get) => {
  /** Changes a tab's view; creates it with default values if needed. */
  const patchView = (tabId: Id, patch: Partial<TabView> | ((view: TabView) => Partial<TabView>)) =>
    set((state) => {
      const current = state.views[tabId] ?? defaultTabView();
      let next = typeof patch === "function" ? patch(current) : patch;
      // Unsaved work in the centre (conflict tool): ask first, the centre stays as is meanwhile.
      if (next.center && next.center !== current.center && centerBlocked(tabId, next.center, (center) => patchView(tabId, { center }))) {
        const { center: _kept, ...rest } = next;
        next = rest;
      }
      return { views: { ...state.views, [tabId]: { ...current, ...next } } };
    });

  let revealNonce = 0;

  return {
    views: {},
    overlay: null,
    profileMenuOpen: false,
    leftWidth: initialWidths.left,
    rightWidth: initialWidths.right,
    narrow: typeof window !== "undefined" ? window.innerWidth < NARROW_WINDOW : false,
    narrowLeftOpen: false,
    jobs: {},
    credentialQueue: [],
    busy: {},
    lastFetch: {},

    selectWip: (tabId) => patchView(tabId, { selection: { kind: "wip" }, rightPanel: "details" }),
    selectCommits: (tabId, shas) =>
      patchView(tabId, { selection: shas.length ? { kind: "commits", shas: [...shas] } : null, rightPanel: "details" }),
    toggleCommit: (tabId, sha) =>
      patchView(tabId, (view) => {
        const current = view.selection?.kind === "commits" ? view.selection.shas : [];
        const shas = current.includes(sha) ? current.filter((item) => item !== sha) : [...current, sha];
        return { selection: shas.length ? { kind: "commits", shas } : null, rightPanel: "details" };
      }),
    selectStash: (tabId, index, sha) =>
      patchView(tabId, {
        selection: { kind: "stash", index },
        rightPanel: "details",
        ...(sha ? { reveal: { sha, key: `stash:${index}`, nonce: ++revealNonce } } : {}),
      }),
    clearSelection: (tabId) => patchView(tabId, { selection: null }),
    revealCommit: (tabId, sha) =>
      patchView(tabId, { selection: { kind: "commits", shas: [sha] }, rightPanel: "details", reveal: { sha, nonce: ++revealNonce } }),

    setCenter: (tabId, center) => patchView(tabId, { center }),
    openDiff: (tabId, path, source) => patchView(tabId, { center: { kind: "diff", path, source } }),
    openFile: (tabId, path, sha, mode = "view") => patchView(tabId, { center: { kind: "file", path, sha, mode } }),
    openHistory: (tabId, path) => patchView(tabId, { center: { kind: "history", path } }),
    openBlame: (tabId, path, sha) => patchView(tabId, { center: { kind: "blame", path, sha } }),
    openConflict: (tabId, path) => patchView(tabId, { center: { kind: "conflict", path } }),
    openRebase: (tabId, base, mode, shas = []) => patchView(tabId, { center: { kind: "rebase", base, mode, shas } }),
    openReflog: (tabId, ref) => patchView(tabId, { center: { kind: "reflog", ref } }),
    closeCenter: (tabId) => patchView(tabId, { center: { kind: "graph" } }),

    setRightPanel: (tabId, panel) => patchView(tabId, { rightPanel: panel, rightCollapsed: false }),
    openStashForm: (tabId) => patchView(tabId, { rightPanel: "stash_form", rightCollapsed: false }),

    setSearchOpen: (tabId, open) =>
      patchView(tabId, (view) => ({ searchOpen: open, search: open ? view.search : { query: "", hits: [], active: -1 } })),
    toggleSearch: (tabId) => get().setSearchOpen(tabId, !(get().views[tabId]?.searchOpen ?? false)),
    setSearch: (tabId, patch) => patchView(tabId, (view) => ({ search: { ...view.search, ...patch } })),
    toggleTerminal: (tabId) => patchView(tabId, (view) => ({ terminalOpen: !view.terminalOpen })),
    toggleLeftPanel: (tabId) => {
      const state = get();
      const view = state.views[tabId] ?? defaultTabView();
      const collapsed = isLeftCollapsed(view, state);
      if (collapsed) {
        patchView(tabId, { leftCollapsed: false });
        if (state.narrow) set({ narrowLeftOpen: true });
      } else if (state.narrow && !view.leftCollapsed) {
        set({ narrowLeftOpen: false });
      } else {
        patchView(tabId, { leftCollapsed: true });
      }
    },
    toggleRightPanel: (tabId) => patchView(tabId, (view) => ({ rightCollapsed: !view.rightCollapsed })),
    setLeftCollapsed: (tabId, collapsed) => {
      patchView(tabId, { leftCollapsed: collapsed });
      if (!collapsed && get().narrow) set({ narrowLeftOpen: true });
    },
    setRightCollapsed: (tabId, collapsed) => patchView(tabId, { rightCollapsed: collapsed }),
    dropTabView: (tabId) =>
      set((state) => {
        if (!(tabId in state.views)) return state;
        const views = { ...state.views };
        delete views[tabId];
        return { views };
      }),

    openOverlay: (overlay) => set({ overlay }),
    setProfileMenuOpen: (profileMenuOpen) => set({ profileMenuOpen }),
    closeOverlay: () => set({ overlay: null }),
    setLeftWidth: (width) => {
      const leftWidth = clampWidth("left", width);
      set({ leftWidth });
      saveWidths(leftWidth, get().rightWidth);
    },
    setRightWidth: (width) => {
      const rightWidth = clampWidth("right", width);
      set({ rightWidth });
      saveWidths(get().leftWidth, rightWidth);
    },
    setNarrow: (narrow) => {
      if (narrow === get().narrow) return;
      set({ narrow, narrowLeftOpen: false });
    },

    startJob: ({ id, title, repoId, askBeforeQuit }) =>
      set((state) => ({
        jobs: { ...state.jobs, [id]: { id, title, repoId, phase: "", percent: null, line: "", startedAt: Date.now(), askBeforeQuit } },
      })),
    updateJob: ({ jobId, repoId, phase, percent, line }) =>
      set((state) => {
        const current = state.jobs[jobId];
        const job: Job = current
          ? { ...current, phase, percent, line }
          : // Job the UI did not start itself (e.g. the core's auto-fetch)
            { id: jobId, title: phase || "Hintergrundaufgabe", repoId, phase, percent, line, startedAt: Date.now() };
        return { jobs: { ...state.jobs, [jobId]: job } };
      }),
    finishJob: (jobId) =>
      set((state) => {
        if (!(jobId in state.jobs)) return state;
        const jobs = { ...state.jobs };
        delete jobs[jobId];
        return { jobs };
      }),

    enqueueCredential: (request) =>
      set((state) =>
        state.credentialQueue.some((item) => item.requestId === request.requestId)
          ? state
          : { credentialQueue: [...state.credentialQueue, request] },
      ),
    resolveCredential: (requestId) =>
      set((state) => ({ credentialQueue: state.credentialQueue.filter((item) => item.requestId !== requestId) })),

    setBusy: (key, busy) =>
      set((state) => {
        if (busy === Boolean(state.busy[key])) return state;
        const next = { ...state.busy };
        if (busy) next[key] = true;
        else delete next[key];
        return { busy: next };
      }),
    markFetched: (repoId, at = Date.now()) => set((state) => ({ lastFetch: { ...state.lastFetch, [repoId]: at } })),
  };
});

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

const fallbackView = defaultTabView();

/** A tab's view; default values as long as nothing has been set. Stable for React. */
export function useTabView(tabId: Id | null | undefined): TabView {
  return useAppStore((state) => (tabId ? state.views[tabId] : undefined) ?? fallbackView);
}

export function getTabView(tabId: Id): TabView {
  return useAppStore.getState().views[tabId] ?? fallbackView;
}

/** Left Panel collapsed – by the user or because the window is narrow. */
export function isLeftCollapsed(view: TabView, state: Pick<AppState, "narrow" | "narrowLeftOpen">): boolean {
  return view.leftCollapsed || (state.narrow && !state.narrowLeftOpen);
}

export function useLeftCollapsed(tabId: Id | null | undefined): boolean {
  return useAppStore((state) => {
    const view = (tabId ? state.views[tabId] : undefined) ?? fallbackView;
    return isLeftCollapsed(view, state);
  });
}

/** Active commit of a commit selection (the most recently selected). */
export function activeSha(selection: Selection): Sha | null {
  if (selection?.kind !== "commits") return null;
  return selection.shas[selection.shas.length - 1] ?? null;
}

export function useBusy(key: string): boolean {
  return useAppStore((state) => Boolean(state.busy[key]));
}

// ---------------------------------------------------------------------------
// Guard for unsaved work in the centre
// ---------------------------------------------------------------------------

/**
 * A view in the centre with unsaved work (conflict tool) registers here.
 * If something wants to switch the centre, the guard asks first; until the answer the centre
 * stays as is, afterwards the switch is carried out.
 */
export interface CenterGuard {
  /** Is there something to lose right now? */
  dirty(): boolean;
  /** Asks the user; true = leave. */
  confirmLeave(): Promise<boolean>;
}

const centerGuards = new Map<Id, CenterGuard>();
const pendingLeave = new Set<Id>();

/** Register (`guard`) or unregister (`null`). Unregistering only affects one's own guard. */
export function setCenterGuard(tabId: Id, guard: CenterGuard | null, owner?: CenterGuard): void {
  if (guard) centerGuards.set(tabId, guard);
  else if (!owner || centerGuards.get(tabId) === owner) centerGuards.delete(tabId);
}

function centerBlocked(tabId: Id, center: CenterView, retry: (center: CenterView) => void): boolean {
  const guard = centerGuards.get(tabId);
  if (!guard || !guard.dirty()) return false;
  if (!pendingLeave.has(tabId)) {
    pendingLeave.add(tabId);
    void guard
      .confirmLeave()
      .then((leave) => {
        pendingLeave.delete(tabId);
        if (!leave) return;
        if (centerGuards.get(tabId) === guard) centerGuards.delete(tabId);
        retry(center);
      })
      .catch(() => pendingLeave.delete(tabId));
  }
  return true;
}

/** Whether any view has reported unsaved work (for the prompt on quit). */
export function hasDirtyCenter(): boolean {
  for (const guard of centerGuards.values()) {
    if (guard.dirty()) return true;
  }
  return false;
}

/** For actions outside the centre (close tab): true if leaving is allowed. */
export async function confirmLeaveCenter(tabId: Id): Promise<boolean> {
  const guard = centerGuards.get(tabId);
  if (!guard || !guard.dirty()) return true;
  const leave = await guard.confirmLeave();
  if (leave && centerGuards.get(tabId) === guard) centerGuards.delete(tabId);
  return leave;
}
