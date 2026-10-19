/**
 * The running version, shown at the right end of the status bar; a click opens the changelog on
 * GitHub (the same address the update check allows, see `RELEASE_PAGE_PREFIX` in the core).
 */

export const CHANGELOG_URL = "https://github.com/abgebaumt/forkyard/blob/main/CHANGELOG.md";

/** "1.2.0" → "v1.2.0". */
export function versionLabel(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}
