/**
 * View state of the "Local changes" panel and the stash form: marked files, form options,
 * presentation. Data from the core does not live here but in the query cache.
 *
 * Per tab, so marks survive switching between commit and stash form and between tabs.
 */
import { create } from "zustand";
import type { Id } from "../../core";
import { nextFileSelection, type FileListView, type FileSelectModifiers } from "../../components/FileList";

export type WipArea = "conflicts" | "unstaged" | "staged";

export interface AreaSelection {
  selected: string[];
  anchor: string | null;
}

export interface WipTabState {
  selection: Record<WipArea, AreaSelection>;
  /** Changed by the user; null = default from the settings. */
  pushAfter: boolean | null;
  skipHooks: boolean;
  /** Error text at the "Summary" field; `nonce` changes on every new attempt (focus onto the field). */
  summaryError: { text: string; nonce: number } | null;
  /** Text that "Amend" loaded into empty fields – take it out again on uncheck if unchanged. */
  amendFilled: { summary: string; description: string } | null;
  /** The commit that was the last one when "Amend" was checked: only it may be amended. */
  amendSha: string | null;
  /**
   * The merge (identified from HEAD) whose prepared message the user has touched. From then on only
   * what is in the field counts – even an empty field stays empty and does not fill up again.
   */
  mergeMessageTouched: string | null;
  /** All paths that were in conflict in the running operation (for "N of M resolved"). */
  conflictSeen: { key: string; paths: string[] };
  stashMessage: string;
  stashUntracked: boolean;
  stashOnlySelected: boolean;
}

const emptySelection = (): AreaSelection => ({ selected: [], anchor: null });

const defaultTab = (): WipTabState => ({
  selection: { conflicts: emptySelection(), unstaged: emptySelection(), staged: emptySelection() },
  pushAfter: null,
  skipHooks: false,
  summaryError: null,
  amendFilled: null,
  amendSha: null,
  mergeMessageTouched: null,
  conflictSeen: { key: "", paths: [] },
  stashMessage: "",
  stashUntracked: true,
  stashOnlySelected: false,
});

const fallbackTab = defaultTab();

export const SPLIT_LIMITS = { min: 0.2, max: 0.8, default: 0.5 } as const;
const PREFS_KEY = "gc.wipPanel";

interface Prefs {
  view: FileListView;
  /** Share of the "Unstaged" section in the height of both lists. */
  split: number;
}

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Prefs>;
      return {
        view: parsed.view === "tree" ? "tree" : "flat",
        split: typeof parsed.split === "number" ? clampSplit(parsed.split) : SPLIT_LIMITS.default,
      };
    }
  } catch {
    // No localStorage: defaults.
  }
  return { view: "flat", split: SPLIT_LIMITS.default };
}

function savePrefs(prefs: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // then only applies until restart
  }
}

export function clampSplit(value: number): number {
  return Math.round(Math.min(SPLIT_LIMITS.max, Math.max(SPLIT_LIMITS.min, value)) * 100) / 100;
}

interface WipState extends Prefs {
  tabs: Record<Id, WipTabState>;
  patch(tabId: Id, patch: Partial<WipTabState> | ((tab: WipTabState) => Partial<WipTabState>)): void;
  /** Click or arrow key in one of the lists. A simple click clears the marks of the other lists. */
  select(tabId: Id, area: WipArea, paths: string[], path: string, modifiers: FileSelectModifiers): void;
  setSelected(tabId: Id, area: WipArea, selected: string[]): void;
  clearSelection(tabId: Id): void;
  setView(view: FileListView): void;
  setSplit(split: number): void;
}

let errorNonce = 0;
export const nextErrorNonce = () => ++errorNonce;

export const useWipStore = create<WipState>()((set, get) => {
  const initial = loadPrefs();
  return {
    ...initial,
    tabs: {},
    patch: (tabId, patch) =>
      set((state) => {
        const current = state.tabs[tabId] ?? defaultTab();
        const next = typeof patch === "function" ? patch(current) : patch;
        return { tabs: { ...state.tabs, [tabId]: { ...current, ...next } } };
      }),
    select: (tabId, area, paths, path, modifiers) =>
      get().patch(tabId, (tab) => {
        const current = tab.selection[area];
        const known = new Set(paths);
        const next = nextFileSelection(paths, current.selected.filter((item) => known.has(item)), current.anchor, path, modifiers);
        const keepOthers = modifiers.additive || modifiers.range;
        return {
          selection: {
            conflicts: keepOthers ? tab.selection.conflicts : emptySelection(),
            unstaged: keepOthers ? tab.selection.unstaged : emptySelection(),
            staged: keepOthers ? tab.selection.staged : emptySelection(),
            [area]: next,
          },
        };
      }),
    setSelected: (tabId, area, selected) =>
      get().patch(tabId, (tab) => ({ selection: { ...tab.selection, [area]: { selected, anchor: selected[selected.length - 1] ?? null } } })),
    clearSelection: (tabId) =>
      get().patch(tabId, { selection: { conflicts: emptySelection(), unstaged: emptySelection(), staged: emptySelection() } }),
    setView: (view) => {
      set({ view });
      savePrefs({ view, split: get().split });
    },
    setSplit: (value) => {
      const split = clampSplit(value);
      set({ split });
      savePrefs({ view: get().view, split });
    },
  };
});

export function useWipTab(tabId: Id): WipTabState {
  return useWipStore((state) => state.tabs[tabId] ?? fallbackTab);
}

export function getWipTab(tabId: Id): WipTabState {
  return useWipStore.getState().tabs[tabId] ?? fallbackTab;
}
