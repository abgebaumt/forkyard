/**
 * Draft of the commit message. The truth lives in the query cache under `qk.draft(repoId)`
 * (useDraft has staleTime Infinity); every change goes into the cache immediately and, debounced,
 * via `draftSet` into the core – so the text survives tab switches and restarts.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { core, type CommitDraft, type Id, type RepoSettings } from "../../core";
import { qk, queryClient, useRepoSettings } from "../../app/queries";

export const EMPTY_DRAFT: CommitDraft = { summary: "", description: "", amend: false };
const SAVE_DELAY_MS = 300;

const timers = new Map<Id, number>();
const pending = new Map<Id, CommitDraft>();
/**
 * Whether the template may still be inserted as the initial value in this repository (until the next commit).
 * Decided as soon as the draft is loaded: if it was empty then, the template waits ("waiting") –
 * it often arrives a moment later from the repository settings. If there was already text, the
 * matter is done ("settled"), even if the user clears the field themselves afterwards.
 */
const templateApplied = new Map<Id, "waiting" | "settled">();
/** The template currently sitting untouched in the field (only in the cache, never saved). */
const templateShown = new Map<Id, MessageParts>();

export function getDraft(repoId: Id): CommitDraft {
  return queryClient.getQueryData<CommitDraft>(qk.draft(repoId)) ?? EMPTY_DRAFT;
}

export const isEmptyDraft = (draft: CommitDraft) => !draft.summary.trim() && !draft.description.trim();

function save(repoId: Id) {
  const draft = pending.get(repoId);
  const timer = timers.get(repoId);
  if (timer !== undefined) window.clearTimeout(timer);
  timers.delete(repoId);
  pending.delete(repoId);
  // If saving fails, the text stays in the field; the next keystroke tries again.
  if (draft) void core.draftSet({ repoId, draft }).catch(() => undefined);
}

/** Changes the draft and saves it in the core shortly after. */
export function updateDraft(repoId: Id, patch: Partial<CommitDraft>): CommitDraft {
  const next = { ...getDraft(repoId), ...patch };
  queryClient.setQueryData(qk.draft(repoId), next);
  pending.set(repoId, next);
  const timer = timers.get(repoId);
  if (timer !== undefined) window.clearTimeout(timer);
  timers.set(repoId, window.setTimeout(() => save(repoId), SAVE_DELAY_MS));
  return next;
}

/** Saves immediately whatever is pending (tab switch, window loses focus, panel disappears). */
export function flushDraft(repoId?: Id): void {
  for (const id of repoId ? [repoId] : [...pending.keys()]) save(id);
}

/** After a commit: the core has already cleared the draft, the cache follows here. Pending saves are dropped. */
export function forgetDraft(repoId: Id): void {
  const timer = timers.get(repoId);
  if (timer !== undefined) window.clearTimeout(timer);
  timers.delete(repoId);
  pending.delete(repoId);
  templateApplied.delete(repoId);
  templateShown.delete(repoId);
  queryClient.setQueryData(qk.draft(repoId), EMPTY_DRAFT);
}

/** Clears the draft in the core too (e.g. after concluding a merge). */
export function clearDraft(repoId: Id): void {
  forgetDraft(repoId);
  void core.draftSet({ repoId, draft: EMPTY_DRAFT }).catch(() => undefined);
}

if (typeof window !== "undefined") {
  window.addEventListener("blur", () => flushDraft());
  window.addEventListener("pagehide", () => flushDraft());
}

// ---------------------------------------------------------------------------
// Commit template
// ---------------------------------------------------------------------------

export interface MessageParts {
  summary: string;
  description: string;
}

/** Splits a message text: first line, blank line, rest. Comment lines (#) of a template are dropped. */
export function splitMessage(text: string, stripComments = false): MessageParts {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const kept = stripComments ? lines.filter((line) => !line.startsWith("#")) : lines;
  while (kept.length && !kept[0]?.trim()) kept.shift();
  const summary = (kept.shift() ?? "").trim();
  while (kept.length && !kept[0]?.trim()) kept.shift();
  return { summary, description: kept.join("\n").replace(/\s+$/, "") };
}

export const joinMessage = (parts: MessageParts) => (parts.description.trim() ? `${parts.summary.trim()}\n\n${parts.description.replace(/\s+$/, "")}` : parts.summary.trim());

const looksAbsolute = (value: string) => /^(~|\/|\\|[A-Za-z]:[\\/])/.test(value);

/**
 * Text of the commit template, without its comment lines (#) – Git does not commit those either.
 * The core returns the content of the effective file as `commitTemplateText`: the repository's
 * `commit.template`, otherwise the global value, also outside the repository (`~/.gitmessage`).
 * Only if it returns nothing does the older rule apply: a file in the repository, or a value that
 * cannot be a path (several lines or spaces) as the template text itself.
 */
export function useCommitTemplate(repoId: Id): MessageParts | null {
  const { data: settings } = useRepoSettings(repoId);
  const fromCore = settings?.commitTemplateText ?? null;
  const value = settings?.commitTemplate?.trim() ?? "";
  const { data: fallback } = useQuery({
    queryKey: [...qk.repoSettings(repoId), "templateText", value] as const,
    enabled: fromCore === null && value.length > 0,
    queryFn: async (): Promise<string | null> => {
      const multiline = /[\r\n]/.test(value);
      if (!multiline && !looksAbsolute(value)) {
        try {
          const file = await core.fileRead({ repoId, path: value, sha: null });
          if (file.text !== null) return file.text;
        } catch {
          // no readable file in the repository
        }
      }
      return multiline || /\s/.test(value) ? value : null;
    },
  });
  const text = fromCore ?? (value ? (fallback ?? null) : null);
  // The same object as long as the text stays the same: effects depend on it.
  return useMemo(() => {
    if (!text) return null;
    const parts = splitMessage(text, true);
    return parts.summary || parts.description ? parts : null;
  }, [text]);
}

const sameParts = (a: MessageParts, b: MessageParts) => a.summary === b.summary && a.description === b.description;

/**
 * Inserts the template as the initial value when there is no draft – once per repository until the next commit.
 * If the template changes (or goes away) while its text still sits untouched in the field, the field follows;
 * typed text always stays.
 */
export function applyTemplate(repoId: Id, template: MessageParts | null): void {
  const draft = queryClient.getQueryData<CommitDraft>(qk.draft(repoId));
  if (!draft) return;
  const shown = templateShown.get(repoId);
  if (shown) {
    if (template && sameParts(shown, template)) return;
    if (!draft.amend && sameParts(draft, shown)) {
      queryClient.setQueryData(qk.draft(repoId), { ...draft, summary: template?.summary ?? "", description: template?.description ?? "" });
      if (template) templateShown.set(repoId, template);
      else {
        templateShown.delete(repoId);
        templateApplied.delete(repoId);
      }
    }
    return;
  }
  if (!templateApplied.has(repoId)) templateApplied.set(repoId, isEmptyDraft(draft) && !draft.amend ? "waiting" : "settled");
  if (!template || templateApplied.get(repoId) !== "waiting") return;
  templateApplied.set(repoId, "settled");
  if (!isEmptyDraft(draft) || draft.amend) return;
  // Only into the cache: it is saved only once the user changes something.
  templateShown.set(repoId, template);
  queryClient.setQueryData(qk.draft(repoId), { ...draft, summary: template.summary, description: template.description });
}

/** The repository's template from the cache (without comment lines), or null. */
export function cachedTemplate(repoId: Id): MessageParts | null {
  const text = queryClient.getQueryData<RepoSettings>(qk.repoSettings(repoId))?.commitTemplateText;
  if (!text) return null;
  const parts = splitMessage(text, true);
  return parts.summary || parts.description ? parts : null;
}

/** Is the draft still exactly the template? Then there is nothing to commit – as with Git in the terminal. */
export function isUntouchedTemplate(repoId: Id, message: MessageParts): boolean {
  const template = cachedTemplate(repoId);
  return template !== null && message.summary.trim() === template.summary && message.description.replace(/\s+$/, "") === template.description;
}
