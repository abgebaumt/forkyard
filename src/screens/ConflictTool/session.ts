/**
 * Work started in the conflict tool survives leaving the view (tab switch, “Continue
 * later”): selection and text of the result are kept here in memory until saved or
 * discarded. Only valid as long as the versions of the file are unchanged.
 */
import type { ConflictFile, Id } from "../../core";
import type { Choice } from "./model";

export interface ConflictSession {
  base: string | null;
  ours: string | null;
  theirs: string | null;
  choices: (Choice | null)[];
  doc: string;
  bounds: number[];
}

const sessions = new Map<string, ConflictSession>();
const key = (repoId: Id, path: string) => `${repoId}\u0000${path}`;

export function loadSession(repoId: Id, path: string, file: ConflictFile): ConflictSession | null {
  const session = sessions.get(key(repoId, path));
  if (!session) return null;
  if (session.base !== file.base || session.ours !== file.ours || session.theirs !== file.theirs) {
    sessions.delete(key(repoId, path));
    return null;
  }
  return session;
}

export function saveSession(repoId: Id, path: string, session: ConflictSession): void {
  sessions.set(key(repoId, path), session);
}

export function dropSession(repoId: Id, path: string): void {
  sessions.delete(key(repoId, path));
}

/** Is there started, unsaved work on this file? */
export function hasSession(repoId: Id, path: string): boolean {
  return sessions.has(key(repoId, path));
}
