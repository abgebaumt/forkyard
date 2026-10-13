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
};
