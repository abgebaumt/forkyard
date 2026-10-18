import type { ReactNode } from "react";
import type { Id } from "../../core";

/** What the text search and the search by meaning share: the typed text and the mode switch. */
export interface SearchPartProps {
  repoId: Id;
  tabId: Id;
  text: string;
  setText: (text: string) => void;
  /** The "Text | Meaning" switch (null while the search by meaning is not shown). */
  modeSwitch: ReactNode;
}
