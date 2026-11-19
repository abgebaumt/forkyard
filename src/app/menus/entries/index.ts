/**
 * Contents of the context menus. Each function reads what it needs to know from the query cache
 * (status, refs, remotes, loaded graph rows) and builds the entries from it: with icon, shortcut,
 * separators, disabled entries with their reason. Dangerous items come last in their group and are
 * red. Every entry calls an action from src/app/actions.
 */
export * from "./commit";
export * from "./wip";
export * from "./branch";
export * from "./refs";
export * from "./files";
export * from "./drop";
export type { MenuBase } from "./shared";
