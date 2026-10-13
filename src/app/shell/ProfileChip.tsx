/**
 * Profile chip in front of the tab strip: colour dot and name of the active profile. The menu
 * switches the profile or leads to the profiles in the preferences.
 */
import { ChevronDown } from "lucide-react";
import type { Profile } from "../../core";
import { DropdownMenu, type MenuEntry } from "../../ui/Menu";
import { cn } from "../../ui/cn";
import { profileColor, switchProfile } from "../actions/profiles";
import { useProfiles } from "../queries";
import { useAppStore } from "../store";
import { t } from "../../i18n";

/** Classes per lane colour 1–8 (written out so Tailwind finds them). */
const LANE_BG = ["bg-lane-1", "bg-lane-2", "bg-lane-3", "bg-lane-4", "bg-lane-5", "bg-lane-6", "bg-lane-7", "bg-lane-8"];

export function ProfileDot({ color, className }: { color: number; className?: string }) {
  return <span className={cn("size-2.5 shrink-0 rounded-full", LANE_BG[color - 1] ?? LANE_BG[0], className)} aria-hidden />;
}

/** Entries of the profile menu; also used for the header of the profile group in the preferences. */
export function profileMenuEntries(profiles: Profile[]): MenuEntry[] {
  const openProfiles = () => useAppStore.getState().openOverlay({ kind: "preferences", section: "profiles" });
  return [
    { type: "label", label: t("shell.profile.menuTitle") },
    ...profiles.map((profile, index) => ({
      label: profile.name,
      hint: profile.authorEmail || undefined,
      icon: <ProfileDot color={profileColor(profile, index)} />,
      checked: profile.isActive,
      onSelect: () => void switchProfile(profile),
    })),
    { type: "separator" },
    { label: t("shell.profile.manage"), onSelect: openProfiles },
  ];
}

export function ProfileChip() {
  const { data: profiles } = useProfiles();
  const open = useAppStore((state) => state.profileMenuOpen);
  const index = Math.max(0, profiles?.findIndex((profile) => profile.isActive) ?? 0);
  const active = profiles?.[index];
  if (!profiles || !active) return null;
  return (
    <DropdownMenu entries={profileMenuEntries(profiles)} open={open} onOpenChange={(next) => useAppStore.getState().setProfileMenuOpen(next)}>
      <button
        type="button"
        data-profile-chip
        aria-label={t("shell.profile.chip", { name: active.name })}
        className="flex h-7 max-w-48 items-center gap-2 rounded-md border border-border bg-surface px-2 text-sm font-semibold text-text hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent"
      >
        <ProfileDot color={profileColor(active, index)} />
        <span className="truncate">{active.name}</span>
        <ChevronDown className="size-3 shrink-0 text-text-muted" aria-hidden />
      </button>
    </DropdownMenu>
  );
}
