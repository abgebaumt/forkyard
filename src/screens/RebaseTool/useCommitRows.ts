/**
 * Commits for squash and cherry-pick mode: details per SHA (message with description, author,
 * parents), in the order of the given SHAs.
 */
import { useMemo } from "react";
import type { CommitInfo, CoreError, Id, Sha } from "../../core";
import { toCoreError } from "../../app/errors";
import { useCommitInfos } from "../../app/queries";

export interface CommitRows {
  pending: boolean;
  error: CoreError | null;
  /** As long as `shas` once nothing is loading anymore. */
  commits: CommitInfo[];
  retry: () => void;
}

export function useCommitRows(repoId: Id, shas: Sha[]): CommitRows {
  const results = useCommitInfos(repoId, shas);
  const pending = results.some((result) => result.isPending);
  const failed = results.find((result) => result.isError);
  const data = results.map((result) => result.data?.commit ?? null);
  const key = data.map((commit) => commit?.sha ?? "-").join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const commits = useMemo(() => data.filter((commit): commit is CommitInfo => commit !== null), [key]);
  return {
    pending,
    error: failed ? toCoreError(failed.error) : null,
    commits,
    retry: () => results.forEach((result) => void (result.isError ? result.refetch() : undefined)),
  };
}
