/**
 * Brief info on selected commits (summary, author, parents) – first from the already loaded
 * graph rows, for everything else from `commitDetails`. No cache of its own: both are queries
 * in the query cache.
 */
import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { core, type Id, type Sha } from "../../core";
import { qk, useGraph } from "../../app/queries";
import type { CommitBrief } from "./logic";

/** The panel makes no more individual requests than this; nobody selects that many commits outside the graph by hand. */
const MAX_LOOKUPS = 60;

export interface CommitBriefs {
  briefs: Map<Sha, CommitBrief>;
  /** There is an entry for every selected commit. */
  ready: boolean;
  loading: boolean;
  error: unknown;
  retry: () => void;
  /** Lane colour of a commit in the graph, if it is shown there. */
  laneOf: (sha: Sha) => number | undefined;
}

export function useCommitBriefs(repoId: Id, shas: Sha[]): CommitBriefs {
  const graph = useGraph(repoId);

  const rows = useMemo(() => {
    const index = new Map<Sha, { brief: CommitBrief; color: number }>();
    let order = 0;
    for (const page of graph.data?.pages ?? []) {
      for (const row of page.rows) {
        if (row.sha && (row.kind === "commit" || row.kind === "merge")) {
          index.set(row.sha, {
            brief: { sha: row.sha, parents: row.parents, summary: row.summary, authorName: row.authorName, authorEmail: row.authorEmail, authoredAt: row.authoredAt, order },
            color: row.color,
          });
        }
        order += 1;
      }
    }
    return index;
  }, [graph.data]);

  // While the graph loads for the first time, individual queries are not worth it: all rows are about to appear.
  const graphSettled = !graph.isPending || graph.isError;
  const missing = graphSettled ? shas.filter((sha) => !rows.has(sha)).slice(0, MAX_LOOKUPS) : [];

  const lookups = useQueries({
    queries: missing.map((sha) => {
      const source = { kind: "commit", sha } as const;
      return {
        queryKey: qk.commitDetails(repoId, source),
        queryFn: () => core.commitDetails({ repoId, source }),
        staleTime: Infinity,
      };
    }),
  });

  const briefs = new Map<Sha, CommitBrief>();
  for (const sha of shas) {
    const row = rows.get(sha);
    if (row) briefs.set(sha, row.brief);
  }
  missing.forEach((sha, index) => {
    const commit = lookups[index]?.data?.commit;
    if (commit) {
      briefs.set(sha, {
        sha,
        parents: commit.parents,
        summary: commit.summary,
        authorName: commit.author.name,
        authorEmail: commit.author.email,
        authoredAt: commit.authoredAt,
        order: null,
      });
    }
  });

  const failed = lookups.find((lookup) => lookup.isError);
  const ready = shas.every((sha) => briefs.has(sha));
  return {
    briefs,
    ready,
    loading: !ready && !failed && (!graphSettled || lookups.some((lookup) => lookup.isPending)),
    error: ready ? null : (failed?.error ?? null),
    retry: () => {
      for (const lookup of lookups) if (lookup.isError) void lookup.refetch();
    },
    laneOf: (sha) => rows.get(sha)?.color,
  };
}
