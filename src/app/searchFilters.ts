/**
 * Filters typed into a commit search: `code:<text>` (commits that add or remove the text),
 * `path:<path>` (repeatable), `since:<date>`, `until:<date>`; values with spaces in double quotes.
 * Everything else stays the search text. The core checks the values.
 */
import type { CommitSearchFilters } from "../core";

export interface ParsedSearch {
  query: string;
  filters: CommitSearchFilters | null;
}

const TOKEN = /(^|\s)(code|path|since|until):(?:"([^"]*)"|(\S+))/g;

export function parseSearchQuery(text: string): ParsedSearch {
  const filters: { pickaxe?: string; since?: string; until?: string; paths?: string[] } = {};
  let found = false;
  const rest = text.replace(TOKEN, (_match, lead: string, key: string, quoted: string | undefined, plain: string | undefined) => {
    const value = (quoted ?? plain ?? "").trim();
    if (!value) return lead;
    found = true;
    if (key === "code") filters.pickaxe = value;
    else if (key === "path") filters.paths = [...(filters.paths ?? []), value];
    else if (key === "since") filters.since = value;
    else filters.until = value;
    return lead;
  });
  return { query: rest.replace(/\s+/g, " ").trim(), filters: found ? filters : null };
}
