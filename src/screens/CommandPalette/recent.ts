/** Commands recently run from the palette (IDs only, newest first), stored locally in the app's browser storage. */

const KEY = "gc.palette.recent";
const MAX = 6;

export function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export function rememberCommand(id: string): void {
  try {
    const next = [id, ...readRecent().filter((item) => item !== id)].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // without storage, simply without “recently used”
  }
}
