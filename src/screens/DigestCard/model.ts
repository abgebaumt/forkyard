/** "What's new since …": the card's numbers and rows from a `Digest` (pure). */
import type { Digest } from "../../core";
import { t } from "../../i18n";

/** After a fetch the card only appears when the seen state is at least this old. */
export const AUTO_MIN_AGE_HOURS = 8;

/** Rows shown before "Show all". */
export const ROW_LIMIT = 8;

export type DigestNumbers = { commits: number; prs: number; files: number };

export function digestNumbers(d: Digest): DigestNumbers {
  // A pull request both changed and commented counts once.
  const prs = new Set([...(d.prs?.changed ?? []), ...(d.prs?.comments ?? [])].map((pr) => pr.number)).size;
  return { commits: d.newCommits, prs, files: d.yourFiles.length };
}

export type DigestRow =
  | { kind: "ref"; key: string; label: string; sha: string | null }
  | { kind: "commit"; key: string; sha: string; label: string }
  | { kind: "pr"; key: string; number: number; label: string }
  | { kind: "file"; key: string; path: string; label: string }
  | { kind: "behind"; key: string; label: string };

/** Behind first, then each ref followed by its commits, then pull requests, then your files. */
export function digestRows(d: Digest): DigestRow[] {
  const rows: DigestRow[] = [];
  if (d.behind) {
    const { branch, base, behind } = d.behind;
    rows.push({ kind: "behind", key: "behind", label: t("digest.behind", { branch, base, count: behind }) });
  }
  for (const ref of d.refs) {
    const word = ref.kind === "tag" && ref.change === "new" ? "newTag" : ref.change;
    // A remote branch and a tag can share a short name.
    const id = `${ref.kind}:${ref.name}`;
    rows.push({ kind: "ref", key: `ref:${id}`, label: t(`digest.ref.${word}`, { name: ref.name }), sha: ref.newSha });
    for (const commit of ref.commits) {
      const label = t("digest.commit", { subject: commit.subject, author: commit.author });
      rows.push({ kind: "commit", key: `commit:${id}:${commit.sha}`, sha: commit.sha, label });
    }
  }
  for (const pr of d.prs?.changed ?? []) {
    rows.push({
      kind: "pr",
      key: `pr:${pr.number}`,
      number: pr.number,
      label: t(`digest.pr.${pr.change}`, { number: pr.number, title: pr.title }),
    });
  }
  for (const pr of d.prs?.comments ?? []) {
    const label = t("digest.pr.comments", { number: pr.number, title: pr.title, count: pr.count });
    rows.push({ kind: "pr", key: `comments:${pr.number}`, number: pr.number, label });
  }
  for (const file of d.yourFiles) {
    rows.push({
      kind: "file",
      key: `file:${file.path}`,
      path: file.path,
      label: t(`digest.file.${file.local ? "local" : "onBranch"}`, { path: file.path }),
    });
  }
  return rows;
}
