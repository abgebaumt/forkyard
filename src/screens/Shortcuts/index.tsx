/**
 * Keyboard shortcuts (Ctrl+/).
 *
 * At the top the shortcuts from the command registry, grouped as in the command palette; below
 * them the fixed keys of the lists and views (graph, files, diff, conflict and rebase tool).
 * A filter field searches description, group and keys. Two columns once wide enough.
 * Kbd shows the keys per platform (see `src/ui/shortcut.ts`).
 */
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Dialog as RadixDialog } from "radix-ui";
import { Command, Search, SearchX, X } from "lucide-react";
import type { AppCommand, CommandGroup } from "../../app/commandTypes";
import { useCommands } from "../../app/registry";
import { useAppStore } from "../../app/store";
import { afterFocusReturn, useFocusReturn } from "../../app/focusReturn";
import { Button } from "../../ui/Button";
import { dialogSurface } from "../../ui/Dialog";
import { Kbd } from "../../ui/Kbd";
import { formatShortcut, isMacShortcuts } from "../../ui/shortcut";
import { matchesShortcut } from "../../app/commandTypes";
import { cn } from "../../ui/cn";
import { fold } from "../CommandPalette/fuzzy";
import { fixedKeyGroups } from "./fixedKeys";
import { t } from "../../i18n";

export interface ShortcutOverlayProps {
  onClose: () => void;
}

interface Entry {
  key: string;
  label: string;
  /** Alternatives; an alternative with "…" in between is a range (Ctrl+1 … Ctrl+8). */
  keys: string[][];
}

interface Section {
  id: string;
  title: string;
  where?: string;
  entries: Entry[];
}

const GROUP_ORDER: CommandGroup[] = ["Allgemein", "Ansicht", "Tabs", "Repository", "Remote", "Branch", "Commit", "Stash", "Datei"];
const GROUP_TITLES: Record<CommandGroup, string> = {
  Allgemein: t("shortcuts.groups.general"),
  Ansicht: t("shortcuts.groups.view"),
  Tabs: t("shortcuts.groups.tabs"),
  Repository: t("shortcuts.groups.repository"),
  Remote: t("shortcuts.groups.remote"),
  Branch: t("shortcuts.groups.branch"),
  Commit: t("shortcuts.groups.commit"),
  Stash: t("shortcuts.groups.stash"),
  Datei: t("shortcuts.groups.file"),
};

function registrySections(commands: readonly AppCommand[]): Section[] {
  const withKeys = commands.filter((command) => command.shortcut);
  const sections: Section[] = [];
  for (const group of GROUP_ORDER) {
    const list = withKeys.filter((command) => command.group === group);
    if (!list.length) continue;
    const entries: Entry[] = [];
    // Ctrl+1 … Ctrl+8 as one row instead of eight.
    const numbered = list.filter((command) => /^tab\.goto\.[1-8]$/.test(command.id));
    for (const command of list) {
      if (numbered.includes(command)) {
        if (command === numbered[0]) {
          entries.push({ key: "tab.goto.range", label: t("shortcuts.gotoTabRange", { count: numbered.length }), keys: [[numbered[0]!.shortcut!, "…", numbered[numbered.length - 1]!.shortcut!]] });
        }
        continue;
      }
      entries.push({ key: command.id, label: command.title.replace(/ …$/, ""), keys: [[command.shortcut!]] });
    }
    sections.push({ id: `group-${group}`, title: GROUP_TITLES[group], entries });
  }
  return sections;
}

const fixedSections: Section[] = fixedKeyGroups.map((group) => ({
  id: `fixed-${group.id}`,
  title: group.title,
  where: group.where,
  entries: group.entries.map((entry, index) => ({ key: `${group.id}-${index}`, label: entry.label, keys: entry.keys.map((key) => [key]) })),
}));

function searchText(section: Section, entry: Entry): string {
  const keys = entry.keys.flat().map((key) => `${key} ${formatShortcut(key)}`);
  return fold(`${entry.label} ${section.title} ${keys.join(" ")}`);
}

function filterSections(sections: Section[], query: string): Section[] {
  const words = fold(query.trim()).split(/\s+/).filter(Boolean);
  if (!words.length) return sections;
  const out: Section[] = [];
  for (const section of sections) {
    const entries = section.entries.filter((entry) => {
      const text = searchText(section, entry);
      return words.every((word) => text.includes(word));
    });
    if (entries.length) out.push({ ...section, entries });
  }
  return out;
}

function Keys({ keys }: { keys: string[][] }) {
  return (
    <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">
      {keys.map((alternative, index) => (
        <span key={index} className="flex items-center gap-1">
          {index > 0 ? <span className="text-xs text-text-muted">{t("shortcuts.or")}</span> : null}
          {alternative.map((key, part) =>
            key === "…" ? (
              <span key={part} className="text-xs text-text-muted">
                {t("shortcuts.to")}
              </span>
            ) : (
              <Kbd key={part}>{key}</Kbd>
            ),
          )}
        </span>
      ))}
    </span>
  );
}

function SectionBlock({ section }: { section: Section }) {
  const headingId = `s26-${section.id}`;
  return (
    <section aria-labelledby={headingId} className="mb-5 break-inside-avoid" data-section={section.id}>
      <h3 id={headingId} className="text-xs font-semibold tracking-wide text-text-muted uppercase">
        {section.title}
      </h3>
      {section.where ? <p className="mt-0.5 text-sm text-text-muted">{section.where}</p> : null}
      <dl className="mt-1.5 flex flex-col">
        {section.entries.map((entry) => (
          <div key={entry.key} className="flex min-h-control-md items-center gap-3 border-b border-border py-1 last:border-b-0" data-entry={entry.key}>
            <dt className="min-w-0 flex-1 text-base text-text">{entry.label}</dt>
            <dd>
              <Keys keys={entry.keys} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Part({ title, children, id }: { title: string; children: ReactNode; id: string }) {
  return (
    <div data-part={id}>
      <h2 className="mb-3 text-md font-semibold text-text">{title}</h2>
      <div className="gap-8 md:columns-2">{children}</div>
    </div>
  );
}

/** Keyboard shortcuts. */
export function ShortcutOverlay({ onClose }: ShortcutOverlayProps) {
  const commands = useCommands();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const focusReturn = useFocusReturn();
  const general = useMemo(() => registrySections(commands), [commands]);
  const shownGeneral = filterSections(general, query);
  const shownFixed = filterSections(fixedSections, query);
  const count = [...shownGeneral, ...shownFixed].reduce((sum, section) => sum + section.entries.length, 0);

  /** Scroll from within the search field: focus stays in the field, the list scrolls. */
  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const list = scrollRef.current;
    if (!list || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const page = Math.max(list.clientHeight - list.clientHeight / 8, 1);
    const line = list.clientHeight / 8;
    let delta = 0;
    if (event.key === "ArrowDown") delta = line;
    else if (event.key === "ArrowUp") delta = -line;
    else if (event.key === "PageDown") delta = page;
    else if (event.key === "PageUp") delta = -page;
    else return;
    event.preventDefault();
    list.scrollBy({ top: delta });
  };

  const openPalette = () => {
    onClose();
    afterFocusReturn(() => useAppStore.getState().openOverlay({ kind: "palette", mode: "commands" }));
  };

  return (
    <RadixDialog.Root open onOpenChange={(open) => !open && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="animate-fade fixed inset-0 z-40 bg-surface-sunken/70" />
        <RadixDialog.Content
          data-screen="shortcuts"
          onCloseAutoFocus={focusReturn.onCloseAutoFocus}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
          onKeyDown={(event) => {
            // The same shortcut closes the overview again (global shortcuts rest while a dialog is open).
            if (matchesShortcut(event.nativeEvent, "Mod+/", isMacShortcuts())) {
              event.preventDefault();
              onClose();
            }
          }}
          onEscapeKeyDown={(event) => {
            // Esc first clears the filter, then closes.
            if (query) {
              event.preventDefault();
              setQuery("");
            }
          }}
          className={cn(dialogSurface, "animate-pop fixed top-1/2 left-1/2 z-50 h-[calc(85vh/var(--zoom,1))] w-shortcuts -translate-x-1/2 -translate-y-1/2")}
        >
          <header className="flex shrink-0 items-start gap-3 border-b border-border px-5 pt-4 pb-3">
            <div className="min-w-0 flex-1">
              <RadixDialog.Title className="text-lg font-semibold">{t("shortcuts.title")}</RadixDialog.Title>
              <RadixDialog.Description className="mt-0.5 text-base text-text-muted">
                {t("shortcuts.description")}
              </RadixDialog.Description>
              <label className="mt-3 flex h-control-md max-w-96 items-center gap-2 rounded-md border border-border-input bg-surface-sunken px-2 focus-within:border-accent focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent">
                <Search className="size-icon shrink-0 text-text-muted" aria-hidden />
                <span className="sr-only">{t("shortcuts.search.label")}</span>
                <input
                  ref={inputRef}
                  type="search"
                  value={query}
                  placeholder={t("shortcuts.search.placeholder")}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => {
                    setQuery(event.target.value);
                    scrollRef.current?.scrollTo({ top: 0 });
                  }}
                  onKeyDown={onInputKeyDown}
                  className="h-full min-w-0 flex-1 bg-transparent text-base text-text placeholder:text-text-muted focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
                />
                {query ? (
                  <button
                    type="button"
                    aria-label={t("shortcuts.search.clear")}
                    onClick={() => {
                      setQuery("");
                      inputRef.current?.focus();
                    }}
                    className="inline-flex size-5 items-center justify-center rounded-sm text-text-muted hover:text-text"
                  >
                    <X className="size-3.5" aria-hidden />
                  </button>
                ) : null}
              </label>
            </div>
            <RadixDialog.Close
              aria-label={t("shortcuts.close")}
              className="inline-flex size-control-sm items-center justify-center rounded-md text-text-muted hover:bg-surface-raised hover:text-text"
            >
              <X className="size-icon" aria-hidden />
            </RadixDialog.Close>
          </header>

          <div
            ref={scrollRef}
            role="region"
            aria-label={t("shortcuts.listLabel")}
            tabIndex={0}
            className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
            data-scroll
          >
            <p className="sr-only" role="status" aria-live="polite">
              {query ? t("shortcuts.matches", { count }) : ""}
            </p>
            {count === 0 ? (
              <div className="flex flex-col items-center gap-2 px-6 py-12 text-center" data-empty>
                <SearchX className="size-6 text-text-muted" aria-hidden />
                <p className="text-md font-medium text-text">{t("shortcuts.empty.title", { query: query.trim() })}</p>
                <p className="max-w-80 text-base text-text-muted">{t("shortcuts.empty.hint")}</p>
              </div>
            ) : null}
            {shownGeneral.length ? (
              <Part id="commands" title={t("shortcuts.parts.commands")}>
                {shownGeneral.map((section) => (
                  <SectionBlock key={section.id} section={section} />
                ))}
              </Part>
            ) : null}
            {shownFixed.length ? (
              <Part id="fixed" title={t("shortcuts.parts.fixed")}>
                {shownFixed.map((section) => (
                  <SectionBlock key={section.id} section={section} />
                ))}
              </Part>
            ) : null}
          </div>

          <footer className="flex shrink-0 items-center gap-3 border-t border-border px-5 py-2.5 text-sm text-text-muted">
            <span className="min-w-0 flex-1 truncate">
              {t("shortcuts.footer")}
            </span>
            <Button size="sm" icon={<Command className="size-icon" aria-hidden />} onClick={openPalette}>
              {t("shortcuts.openPalette")}
            </Button>
          </footer>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
