/**
 * What the "Connect account" dialog explains: where to create a token at the host and which
 * permissions it needs. Permission names are written the way the host calls them (English), so
 * they can be found there; everything else in our own words.
 */
import type { HostKind } from "../../app/actions/hostTypes";
import { t } from "../../i18n";

export interface TokenPermission {
  /** Name at the host. */
  name: string;
  /** What the app needs it for. */
  why: string;
}

export interface TokenVariant {
  title: string;
  intro: string;
  permissions: TokenPermission[];
}

export interface TokenGuide {
  /** Path through the host's UI, step by step. */
  path: string[];
  variants: TokenVariant[];
  notes: string[];
}

export const tokenGuides: Record<HostKind, TokenGuide> = {
  github: {
    path: t("hosts.guide.github.path").split("|"),
    variants: [
      {
        title: t("hosts.guide.github.fineGrained"),
        intro: t("hosts.guide.github.fineGrainedIntro"),
        permissions: [
          { name: "Pull requests: Read and write", why: t("hosts.guide.github.pullRequests") },
          { name: "Contents: Read and write", why: t("hosts.guide.github.contents") },
          { name: "Commit statuses: Read", why: t("hosts.guide.github.statuses") },
          { name: "Issues: Read", why: t("hosts.guide.github.issues") },
          { name: "Metadata: Read", why: t("hosts.guide.github.metadata") },
        ],
      },
      {
        title: t("hosts.guide.github.classic"),
        intro: t("hosts.guide.github.classicIntro"),
        permissions: [{ name: "repo", why: t("hosts.guide.github.repo") }],
      },
    ],
    notes: [t("hosts.guide.github.sso")],
  },
  gitlab: {
    path: t("hosts.guide.gitlab.path").split("|"),
    variants: [
      {
        title: t("hosts.guide.gitlab.personal"),
        intro: t("hosts.guide.gitlab.personalIntro"),
        permissions: [{ name: "api", why: t("hosts.guide.gitlab.api") }],
      },
    ],
    notes: [t("hosts.guide.gitlab.roles")],
  },
  gitea: {
    path: t("hosts.guide.gitea.path").split("|"),
    variants: [
      {
        title: t("hosts.guide.gitea.personal"),
        intro: t("hosts.guide.gitea.personalIntro"),
        permissions: [
          { name: "write:repository", why: t("hosts.guide.gitea.repository") },
          { name: "write:issue", why: t("hosts.guide.gitea.issue") },
          { name: "read:user", why: t("hosts.guide.gitea.user") },
        ],
      },
    ],
    notes: [t("hosts.guide.gitea.forgejo")],
  },
  bitbucket: {
    path: t("hosts.guide.bitbucket.path").split("|"),
    variants: [
      {
        title: t("hosts.guide.bitbucket.personal"),
        intro: t("hosts.guide.bitbucket.personalIntro"),
        permissions: [
          { name: "read:repository:bitbucket", why: t("hosts.guide.bitbucket.repository") },
          { name: "write:pullrequest:bitbucket", why: t("hosts.guide.bitbucket.pullrequest") },
          { name: "read:issue:bitbucket", why: t("hosts.guide.bitbucket.issue") },
          { name: "read:user:bitbucket", why: t("hosts.guide.bitbucket.user") },
        ],
      },
    ],
    notes: [t("hosts.guide.bitbucket.email"), t("hosts.guide.bitbucket.appPasswords")],
  },
  azure_devops: {
    path: t("hosts.guide.azure.path").split("|"),
    variants: [
      {
        title: t("hosts.guide.azure.personal"),
        intro: t("hosts.guide.azure.personalIntro"),
        permissions: [
          { name: "Code (Read & write)", why: t("hosts.guide.azure.code") },
          { name: "Work Items (Read & write)", why: t("hosts.guide.azure.workItems") },
        ],
      },
    ],
    notes: [t("hosts.guide.azure.organization")],
  },
};

export const instanceLabels: Record<HostKind, { public: string; own: string; ownHint: string; placeholder: string }> = {
  github: {
    public: "github.com",
    own: t("hosts.instance.own"),
    ownHint: t("hosts.instance.githubHint"),
    placeholder: t("hosts.instance.githubPlaceholder"),
  },
  gitlab: {
    public: "gitlab.com",
    own: t("hosts.instance.own"),
    ownHint: t("hosts.instance.gitlabHint"),
    placeholder: t("hosts.instance.gitlabPlaceholder"),
  },
  gitea: {
    public: "codeberg.org",
    own: t("hosts.instance.own"),
    ownHint: t("hosts.instance.giteaHint"),
    placeholder: t("hosts.instance.giteaPlaceholder"),
  },
  // Bitbucket Cloud and Azure DevOps have no self-hosted instance here (see hostHasInstances).
  bitbucket: { public: "bitbucket.org", own: t("hosts.instance.own"), ownHint: "", placeholder: "" },
  azure_devops: { public: "dev.azure.com", own: t("hosts.instance.own"), ownHint: "", placeholder: "" },
};
