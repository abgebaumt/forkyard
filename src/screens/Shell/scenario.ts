/**
 * Scenarios for the shell's interaction layer: credential prompts, context menus, toolbar states.
 * Usage: `?scenario=shell.credential&kind=password`, `?scenario=shell.menu&which=commit`.
 */
import type { CredentialKind, CredentialRequest, FileChange } from "../../core";
import { branchMenu, branchesMenu, commitMenu, dropMenu, fileMenu, openMenuAt, remoteMenu, stashMenu, tagMenu, wipMenu } from "../../app/menus";
import { GRAPH_PAGE_SIZE, qk } from "../../app/queries";
import type { Scenario, ScenarioContext } from "../scenarios";

const credentialSamples: Record<CredentialKind, Omit<CredentialRequest, "requestId">> = {
  username: {
    kind: "username",
    host: "git.messnetz.example",
    username: null,
    detail: null,
    prompt: "Username for 'https://git.messnetz.example': ",
    canRemember: false,
  },
  password: {
    kind: "password",
    host: "git.messnetz.example",
    username: "lena.hartmann",
    detail: null,
    prompt: "Password for 'https://lena.hartmann@git.messnetz.example': ",
    canRemember: true,
  },
  passphrase: {
    kind: "passphrase",
    host: "",
    username: null,
    detail: "C:\\Users\\lena\\.ssh\\id_ed25519_messnetz",
    prompt: "Enter passphrase for key 'C:\\Users\\lena\\.ssh\\id_ed25519_messnetz': ",
    canRemember: true,
  },
  host_key: {
    kind: "host_key",
    host: "git.messnetz.example",
    username: null,
    detail: "SHA256:Wq7mK2xk0c1dYtH3nV9fJ5uRz8aLpE4sBvT6gQoXyZc",
    prompt: "The authenticity of host 'git.messnetz.example (203.0.113.17)' can't be established.",
    canRemember: false,
  },
};

/** Loads what the menus read from the cache – as long as the graph and left panel don't do it themselves. */
async function seed(ctx: ScenarioContext, repoId: string) {
  const client = ctx.queryClient;
  const [status, refs, remotes, stashes] = await Promise.all([
    client.fetchQuery({ queryKey: qk.status(repoId), queryFn: () => ctx.core.statusGet({ repoId }), staleTime: 0 }),
    client.fetchQuery({ queryKey: qk.refs(repoId), queryFn: () => ctx.core.refsList({ repoId }), staleTime: 0 }),
    client.fetchQuery({ queryKey: qk.remotes(repoId), queryFn: () => ctx.core.remoteList({ repoId }), staleTime: 0 }),
    client.fetchQuery({ queryKey: qk.stashes(repoId), queryFn: () => ctx.core.stashList({ repoId }), staleTime: 0 }),
    client.fetchQuery({ queryKey: qk.viewState(repoId), queryFn: () => ctx.core.viewStateGet({ repoId }), staleTime: 0 }),
    client.fetchInfiniteQuery({
      queryKey: qk.graph(repoId),
      queryFn: ({ pageParam }) => ctx.core.graphPage({ repoId, cursor: pageParam, limit: 4 * GRAPH_PAGE_SIZE }),
      initialPageParam: null as string | null,
      staleTime: 0,
    }),
  ]);
  return { status, refs, remotes, stashes };
}

export const scenarios: Record<string, Scenario> = {
  /** A credential prompt is in the store: `kind=username|password|passphrase|host_key`; `queue=1` puts all four in. */
  async credential(ctx) {
    const kind = (ctx.params.get("kind") ?? "password") as CredentialKind;
    const store = ctx.store.getState();
    const kinds: CredentialKind[] = ctx.params.get("queue") ? [kind, ...(Object.keys(credentialSamples) as CredentialKind[]).filter((item) => item !== kind)] : [kind];
    kinds.forEach((item, index) => store.enqueueCredential({ ...credentialSamples[item], requestId: `szenario-${item}-${index}` }));
    await ctx.waitFor(() => document.querySelector("[data-credential]") !== null);
  },

  /**
   * A context menu is open: `which=commit|head|commits|wip|branch|current|remoteBranch|branches|tag|stash|remote|file|staged|commitFile|drop|dropRemote`.
   * Needs a repository (`fixture=<path>` or an active repo tab); meant for the "rich" fixture.
   */
  async menu(ctx) {
    const { repoId, tabId } = await ctx.repo();
    const base = { repoId, tabId };
    const { status, refs, remotes, stashes } = await seed(ctx, repoId);
    const which = ctx.params.get("which") ?? "commit";
    const head = status.head.kind === "unborn" ? null : status.head.sha;
    const rows = (await ctx.core.graphPage({ repoId, cursor: null, limit: 200 })).rows.filter((row) => row.kind === "commit" || row.kind === "merge");
    const local = (name: string) => refs.locals.find((ref) => ref.name === name);
    const other = refs.locals.find((ref) => !ref.isHead && ref.sha !== head) ?? refs.locals.find((ref) => !ref.isHead);
    const current = refs.locals.find((ref) => ref.isHead);
    const file = (list: FileChange[]) => list.find((item) => item.status === "modified" && !item.isBinary) ?? list[0];
    const point = { x: Number(ctx.params.get("x") ?? 420), y: Number(ctx.params.get("y") ?? 96) };

    const entries = (() => {
      switch (which) {
        case "head":
          return head ? commitMenu({ ...base, shas: [head] }) : [];
        case "commit":
          return rows[4]?.sha ? commitMenu({ ...base, shas: [rows[4].sha] }) : [];
        case "commits":
          return commitMenu({ ...base, shas: rows.slice(0, 2).map((row) => row.sha!) });
        case "commitsApart":
          return commitMenu({ ...base, shas: [rows[0]!.sha!, rows[3]!.sha!, rows[5]!.sha!] });
        case "wip":
          return wipMenu(base);
        case "branch":
          return other ? branchMenu({ ...base, ref: local(ctx.params.get("name") ?? "") ?? other }) : [];
        case "current":
          return current ? branchMenu({ ...base, ref: current }) : [];
        case "remoteBranch":
          return refs.remotes[0] ? branchMenu({ ...base, ref: refs.remotes.find((ref) => !local(ref.name.slice((ref.remote?.length ?? 0) + 1))) ?? refs.remotes[0] }) : [];
        case "branches":
          return branchesMenu({ ...base, refs: refs.locals });
        case "tag":
          return refs.tags[0] ? tagMenu({ ...base, ref: refs.tags.find((tag) => tag.isAnnotated) ?? refs.tags[0] }) : [];
        case "stash":
          return stashes[0] ? stashMenu({ ...base, stash: stashes[0] }) : [];
        case "remote":
          return remotes[0] ? remoteMenu({ ...base, remote: remotes[0] }) : [];
        case "file": {
          const target = file(status.unstaged);
          return target ? fileMenu({ ...base, files: [target], source: { kind: "unstaged" } }) : [];
        }
        case "staged": {
          const target = file(status.staged);
          return target ? fileMenu({ ...base, files: [target], source: { kind: "staged" } }) : [];
        }
        case "commitFile": {
          if (!head) return [];
          const target: FileChange = { path: "README.md", oldPath: null, status: "modified", area: "commit", isBinary: false, isLfs: false, added: 4, removed: 0, conflict: null };
          return fileMenu({ ...base, files: [target], source: { kind: "commit", sha: head } });
        }
        case "drop":
          return other && current ? dropMenu({ ...base, source: other, target: current }) : [];
        case "dropRemote": {
          const target = refs.remotes.find((ref) => ref.name !== current?.upstream) ?? refs.remotes[0];
          return current && target ? dropMenu({ ...base, source: current, target }) : [];
        }
        default:
          return [];
      }
    })();
    if (entries.length === 0) throw new Error(`Nothing to show for "${which}" in this repository.`);
    openMenuAt(point, entries, "Szenario");
    await ctx.waitFor(() => document.querySelector('[role="menu"]') !== null);
  },
};
