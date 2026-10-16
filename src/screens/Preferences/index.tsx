/**
 * Settings on three levels: global (the same in all profiles), profile (only in the active
 * profile) and project (only the repository in the active tab; inherits from the profile). Large
 * dialog: search and sections on the left (arrow keys), content on the right. Every change takes
 * effect immediately; Esc closes.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Bell,
  Bot,
  Command,
  FileCog,
  FolderGit2,
  GitBranch,
  Globe,
  Info,
  KeyRound,
  Link2,
  Network,
  Palette,
  Plug,
  Search,
  ShieldCheck,
  SquareTerminal,
  TextCursorInput,
  UserRound,
  X,
} from "lucide-react";
import { Dialog as RadixDialog, Tabs } from "radix-ui";
import type { Id } from "../../core";
import { profileColor } from "../../app/actions/profiles";
import { useProfiles, useRepo, useRepoSettings, useSettings } from "../../app/queries";
import { ProfileDot, profileMenuEntries } from "../../app/shell/ProfileChip";
import type { PreferencesSection } from "../../app/store";
import { dialogSurface, shiftTabFromFrame } from "../../ui/Dialog";
import { DropdownMenu } from "../../ui/Menu";
import { Tip } from "../../ui/Tooltip";
import { cn } from "../../ui/cn";
import { t } from "../../i18n";
import { ownCount, SECTION_KEYS } from "./inherit";
import { searchSections, visibleSections, type Level, type SectionId } from "./nav";
import { LoadError, ScopePill, SettingsSearch, SettingsSkeleton } from "./parts";
import { AboutSection } from "./sections/About";
import { AppearanceSection, DiffSection, ExternalSection, GitSection, NotificationsSection } from "./sections/AppSections";
import { CredentialsSection } from "./sections/Credentials";
import { ProfilesSection } from "./sections/Profiles";
import { ProjectFilesSection, ProjectGitSection, ProjectIdentitySection } from "./sections/ProjectSections";
import { TicketLinksSection } from "./sections/TicketLinks";
import { SshSection } from "./sections/Ssh";
import { NetworkSection } from "../Network/NetworkSection";
import { HostsSection } from "../Hosts";
import { CustomCommandsSection } from "../CustomCommands/Section";
import { AgentTemplatesSection } from "../Agents/SettingsSection";

/** The shell knows coarser names; here they land in the matching section. */
const fromStore: Record<PreferencesSection, SectionId> = {
  general: "git",
  ui: "appearance",
  signing: "git",
  editor: "diff",
  external: "external",
  commands: "commands",
  terminal: "external",
  notifications: "notifications",
  profiles: "identity",
  ssh: "ssh",
  integrations: "integrations",
  repo: "p-identity",
  agents: "agents",
};

const iconClass = "size-icon shrink-0";
const icons: Record<SectionId, ReactNode> = {
  appearance: <Palette className={iconClass} aria-hidden />,
  diff: <TextCursorInput className={iconClass} aria-hidden />,
  external: <SquareTerminal className={iconClass} aria-hidden />,
  commands: <Command className={iconClass} aria-hidden />,
  notifications: <Bell className={iconClass} aria-hidden />,
  agents: <Bot className={iconClass} aria-hidden />,
  identity: <UserRound className={iconClass} aria-hidden />,
  git: <GitBranch className={iconClass} aria-hidden />,
  ssh: <KeyRound className={iconClass} aria-hidden />,
  credentials: <ShieldCheck className={iconClass} aria-hidden />,
  integrations: <Plug className={iconClass} aria-hidden />,
  network: <Network className={iconClass} aria-hidden />,
  "p-identity": <FolderGit2 className={iconClass} aria-hidden />,
  "p-git": <GitBranch className={iconClass} aria-hidden />,
  "p-files": <FileCog className={iconClass} aria-hidden />,
  "p-links": <Link2 className={iconClass} aria-hidden />,
  about: <Info className={iconClass} aria-hidden />,
};

export function Preferences({
  section,
  request,
  createProfile = false,
  repoId,
  onClose,
}: {
  section: PreferencesSection;
  request?: object;
  createProfile?: boolean;
  repoId: Id | null;
  onClose: () => void;
}) {
  const [active, setActive] = useState<SectionId>(fromStore[section] ?? "appearance");
  // A new call while the dialog is open (e.g. "Manage profiles …") jumps to the requested section.
  useEffect(() => {
    setActive(fromStore[section] ?? "appearance");
  }, [request, section]);
  const [query, setQuery] = useState("");
  const settings = useSettings();
  const { data: profiles } = useProfiles();
  const { data: repo } = useRepo(repoId);
  const { data: repoSettings } = useRepoSettings(repoId);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const sections = visibleSections(Boolean(repoId));
  const hits = searchSections(query, sections);
  // When the profile changes the repo tab may disappear: then the project sections no longer exist.
  const shown: SectionId = sections.some((item) => item.id === active) ? active : "appearance";
  const profileIndex = Math.max(0, profiles?.findIndex((profile) => profile.isActive) ?? 0);
  const profile = profiles?.[profileIndex];
  const repoName = repo?.alias ?? repo?.name ?? t("preferences.repoFallback");

  const withSettings = (render: (value: NonNullable<typeof settings.data>) => ReactNode) => {
    if (settings.isPending) return <SettingsSkeleton />;
    if (settings.isError) return <LoadError title={t("preferences.loadError.settings")} error={settings.error} onRetry={() => void settings.refetch()} />;
    return render(settings.data);
  };

  const search = (value: string) => {
    setQuery(value);
    // If nothing matches in the shown section, the view jumps to the first section with matches.
    const found = searchSections(value, sections);
    const first = sections.find((item) => found.has(item.id));
    if (first && !found.has(shown)) setActive(first.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
      return;
    }
    shiftTabFromFrame(event);
  };

  const groupHead = (level: Level) => {
    const title = "mt-3 mb-1 flex min-w-0 items-center gap-1.5 px-2 text-xs font-semibold tracking-wide text-text-muted";
    if (level === "profile" && profile && profiles) {
      return (
        <div aria-hidden className={title}>
          <ProfileDot color={profileColor(profile, profileIndex)} className="size-2" />
          <span className="min-w-0 truncate normal-case tracking-normal text-text" title={t("preferences.levels.profileTitle", { name: profile.name })}>
            {t("preferences.levels.profile", { name: profile.name })}
          </span>
        </div>
      );
    }
    const label =
      level === "global"
        ? t("preferences.levels.global")
        : level === "project"
          ? t("preferences.levels.project", { name: repoName })
          : t("preferences.levels.help");
    return (
      <p aria-hidden title={label} className={cn(title, level === "project" ? "normal-case tracking-normal text-text" : "uppercase")}>
        <span className="truncate">{label}</span>
      </p>
    );
  };

  const scope = (level: Level) => {
    if (level === "global") return <ScopePill icon={<Globe className="size-3.5" aria-hidden />}>{t("preferences.scope.global")}</ScopePill>;
    if (level === "profile" && profile)
      return (
        <div className="flex items-center gap-2">
          <ScopePill icon={<ProfileDot color={profileColor(profile, profileIndex)} className="size-2" />}>{t("preferences.scope.profile", { name: profile.name })}</ScopePill>
          {/* Outside the section list: a tab list may only contain tabs. */}
          {profiles ? (
            <DropdownMenu entries={profileMenuEntries(profiles)} align="start">
              <button type="button" className="mb-2 rounded-sm px-1 text-xs font-medium text-accent hover:underline">
                {t("preferences.levels.switch")}
              </button>
            </DropdownMenu>
          ) : null}
        </div>
      );
    if (level === "project")
      return (
        <ScopePill icon={<FolderGit2 className="size-3.5" aria-hidden />}>
          {t("preferences.scope.project", { repo: repoName })}
          {profile ? t("preferences.scope.projectOverrides", { profile: profile.name }) : ""}
        </ScopePill>
      );
    return null;
  };

  const tail = (id: SectionId) => {
    if (query.trim()) {
      const count = hits.get(id);
      return count ? <span className="text-xs font-semibold text-accent">{count}</span> : null;
    }
    const keys = id === "p-identity" || id === "p-git" ? SECTION_KEYS[id] : null;
    const own = keys && repoSettings ? ownCount(repoSettings, keys) : 0;
    return own > 0 ? <span className="text-xs text-warning">{t("preferences.nav.own", { count: own })}</span> : null;
  };

  const levels: Level[] = ["global", "profile", "project", "help"];
  const levelOf = (id: SectionId) => sections.find((item) => item.id === id)?.level ?? "help";

  const panel = (id: SectionId) => {
    switch (id) {
      case "appearance":
        return withSettings((value) => <AppearanceSection settings={value} />);
      case "diff":
        return withSettings((value) => <DiffSection settings={value} />);
      case "external":
        return withSettings((value) => <ExternalSection settings={value} />);
      case "commands":
        return <CustomCommandsSection repoId={repo?.trusted ? repoId : null} />;
      case "notifications":
        return withSettings((value) => <NotificationsSection settings={value} />);
      case "agents":
        return withSettings((value) => <AgentTemplatesSection settings={value} />);
      case "identity":
        return <ProfilesSection create={createProfile} />;
      case "git":
        return withSettings((value) => <GitSection settings={value} />);
      case "ssh":
        return withSettings((value) => <SshSection settings={value} />);
      case "credentials":
        return <CredentialsSection />;
      case "integrations":
        return <HostsSection />;
      case "network":
        return withSettings((value) => <NetworkSection settings={value} />);
      case "p-identity":
        return repoId ? <ProjectIdentitySection key={repoId} repoId={repoId} /> : null;
      case "p-git":
        return repoId ? <ProjectGitSection key={repoId} repoId={repoId} /> : null;
      case "p-files":
        return repoId ? <ProjectFilesSection key={repoId} repoId={repoId} /> : null;
      case "p-links":
        return repoId ? <TicketLinksSection key={repoId} repoId={repoId} /> : null;
      case "about":
        return <AboutSection />;
    }
  };

  return (
    <RadixDialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="animate-fade fixed inset-0 z-40 bg-surface-sunken/70" />
        <RadixDialog.Content
          data-screen="settings"
          aria-describedby={undefined}
          className={cn(dialogSurface, "animate-pop fixed top-1/2 left-1/2 z-50 h-170 w-232 -translate-x-1/2 -translate-y-1/2 overflow-hidden")}
          onKeyDown={onKeyDown}
          onEscapeKeyDown={(event) => {
            // Esc first clears the search; a second Esc closes the dialog. Radix hears Esc before the
            // field itself, hence here.
            if (query && document.activeElement === searchRef.current) {
              event.preventDefault();
              search("");
            }
          }}
          onOpenAutoFocus={(event) => {
            // Focus belongs in the section list, not on the close button.
            event.preventDefault();
            listRef.current?.querySelector<HTMLElement>('[role="tab"][data-state="active"]')?.focus();
          }}
        >
          <SettingsSearch.Provider value={query}>
            <Tabs.Root orientation="vertical" value={shown} onValueChange={(value) => setActive(value as SectionId)} className="flex min-h-0 flex-1">
              <nav aria-label={t("preferences.nav.label")} className="flex w-60 shrink-0 flex-col border-r border-border bg-surface-sunken">
                <RadixDialog.Title className="px-4 pt-4 pb-2 text-lg font-semibold">{t("preferences.title")}</RadixDialog.Title>
                <label className="mx-3 mb-1 flex h-control-md items-center gap-2 rounded-md border border-border-input bg-surface-raised px-2 focus-within:outline-2 focus-within:outline-accent">
                  <Search className="size-3.5 shrink-0 text-text-muted" aria-hidden />
                  <input
                    ref={searchRef}
                    type="search"
                    value={query}
                    onChange={(event) => search(event.target.value)}
                    placeholder={t("preferences.search")}
                    aria-label={t("preferences.search")}
                    className="min-w-0 flex-1 bg-transparent text-base text-text outline-none placeholder:text-text-muted"
                  />
                </label>
                <Tabs.List ref={listRef} aria-label={t("preferences.nav.list")} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3">
                  {levels
                    .filter((level) => sections.some((item) => item.level === level))
                    .map((level) => (
                      <div key={level} role="presentation" className="flex flex-col">
                        {groupHead(level)}
                        {sections
                          .filter((item) => item.level === level)
                          .map((item) => (
                            <Tabs.Trigger
                              key={item.id}
                              value={item.id}
                              className={cn(
                                "flex h-control-md shrink-0 items-center gap-2 rounded-md px-2 text-left text-base text-text-muted",
                                "hover:bg-surface-raised hover:text-text",
                                "data-[state=active]:bg-accent-surface data-[state=active]:font-medium data-[state=active]:text-text",
                                query.trim() && !hits.has(item.id) && "opacity-60",
                              )}
                            >
                              {icons[item.id]}
                              <span className="min-w-0 flex-1 truncate">{item.label}</span>
                              {tail(item.id)}
                            </Tabs.Trigger>
                          ))}
                      </div>
                    ))}
                </Tabs.List>
                <p className="border-t border-border px-4 py-2 text-xs text-text-muted">{t("preferences.nav.appliesNow")}</p>
              </nav>

              <div className="relative flex min-w-0 flex-1 flex-col">
                <Tip label={t("preferences.nav.close")} shortcut="Esc">
                  <RadixDialog.Close
                    aria-label={t("preferences.nav.closeLabel")}
                    className="absolute top-3 right-3 z-10 inline-flex size-control-md items-center justify-center rounded-md text-text-muted hover:bg-surface-raised hover:text-text"
                  >
                    <X className="size-icon" aria-hidden />
                  </RadixDialog.Close>
                </Tip>
                <div className="min-h-0 flex-1 overflow-y-auto" data-prefs-scroll>
                  {sections.map((item) => (
                    <Tabs.Content key={item.id} value={item.id} tabIndex={-1} className="px-6 pt-4 pb-8 outline-none">
                      <div className="max-w-160">
                        {scope(levelOf(item.id))}
                        {item.id === shown ? panel(item.id) : null}
                      </div>
                    </Tabs.Content>
                  ))}
                </div>
              </div>
            </Tabs.Root>
          </SettingsSearch.Provider>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
