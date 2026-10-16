import type { Ref, Remote } from "../../core";

/**
 * The remote that points to the original of a fork (often "upstream"): the one whose address ends
 * in `<owner>/<name>`. null if there is none.
 */
export function parentRemote(remotes: Pick<Remote, "name" | "fetchUrl">[], parent: { owner: string; name: string } | null, own: string | null): string | null {
  if (!parent) return null;
  const wanted = `${parent.owner}/${parent.name}`.toLowerCase();
  const path = (url: string) => url.trim().replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
  const found = remotes.find((remote) => remote.name !== own && (path(remote.fetchUrl).endsWith(`/${wanted}`) || path(remote.fetchUrl).endsWith(`:${wanted}`)));
  return found?.name ?? null;
}

/** "anna, bernd ,, clara" → ["anna", "bernd", "clara"]; a leading @ is dropped, so are duplicates. */
export function splitNames(input: string): string[] {
  const seen = new Set<string>();
  for (const part of input.split(/[,;\n]/)) {
    const name = part.trim().replace(/^@/, "");
    if (name) seen.add(name);
  }
  return [...seen];
}

/**
 * Possible target branches: the remote's branches (with several remotes those of `origin` first),
 * without the remote's prefix and without duplicates. The host's default branch comes first – even
 * if it has not been fetched locally yet. `only`: only the branches of this remote (the remote that
 * belongs to the host); if the app knows none of its branches yet, those of all remotes apply.
 */
export function targetBranches(remoteRefs: Pick<Ref, "name" | "remote">[], remotes: Pick<Remote, "name">[], defaultBranch: string | null, only: string | null = null): string[] {
  const scoped = only ? remoteRefs.filter((ref) => ref.remote === only) : remoteRefs;
  if (scoped.length) remoteRefs = scoped;
  const order = [...remotes.map((remote) => remote.name)].sort((a, b) => (a === "origin" ? -1 : b === "origin" ? 1 : 0));
  const rank = (remote: string | null) => {
    const index = remote ? order.indexOf(remote) : -1;
    return index < 0 ? order.length : index;
  };
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (name: string | null) => {
    if (!name || name === "HEAD" || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };
  add(defaultBranch);
  for (const ref of [...remoteRefs].sort((a, b) => rank(a.remote) - rank(b.remote))) {
    add(ref.remote && ref.name.startsWith(`${ref.remote}/`) ? ref.name.slice(ref.remote.length + 1) : ref.name);
  }
  return names;
}

/**
 * The ref a pull request's target branch stands for in this repository: `<remote>/<name>` of the
 * given remote (the host's or the original's), else of any remote, else the local branch; null if
 * none is known. The AI request passes its `fullName`, so a local branch called `origin/main`
 * cannot be mistaken for the remote one.
 */
export function targetRef<T extends Pick<Ref, "name" | "remote">>(remoteRefs: T[], locals: T[], remote: string | null, name: string): T | null {
  return (
    remoteRefs.find((ref) => remote !== null && ref.name === `${remote}/${name}`) ??
    remoteRefs.find((ref) => ref.remote !== null && ref.name === `${ref.remote}/${name}`) ??
    locals.find((ref) => ref.name === name) ??
    null
  );
}
