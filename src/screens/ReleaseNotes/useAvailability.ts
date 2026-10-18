/**
 * Whether release notes are offered for a repository, and which host targets exist. While the
 * repository settings are still loading the function counts as "AI off here", so a repository
 * with AI off never flashes the button; the host is only asked once the function is visible.
 */
import type { Id } from "../../core";
import { featureVisible } from "../../app/ai/visibility";
import { useAiStatus, useHostRepo, useRepoSettings } from "../../app/queries";
import { availabilityOf, type ReleaseNotesAvailability } from "./model";

export function useReleaseNotesAvailability(repoId: Id): ReleaseNotesAvailability {
  const status = useAiStatus().data;
  const settings = useRepoSettings(repoId).data;
  const repoAiOff = settings ? settings.aiOff : true;
  const visible = featureVisible(status, "release_notes", repoAiOff);
  const host = useHostRepo(visible ? repoId : null).data ?? null;
  return availabilityOf(status, repoAiOff, host);
}
