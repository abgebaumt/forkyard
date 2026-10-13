import type { Id } from "../../core";
import { ChangesPanel } from "./ChangesPanel";
import { CommitForm } from "./CommitForm";

export interface WipPanelProps {
  repoId: Id;
  tabId: Id;
}

/** Local changes: stage, write a message, commit. */
export function WipPanel({ repoId, tabId }: WipPanelProps) {
  return <ChangesPanel repoId={repoId} tabId={tabId} mode="commit" footer={<CommitForm repoId={repoId} tabId={tabId} />} />;
}
