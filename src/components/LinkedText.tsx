/**
 * Text with ticket links: matches of the repository's link rules become buttons that open the
 * address in the browser. Buttons, not <a href>: the webview must never navigate, and the graph
 * rows ignore clicks on buttons (no selection change).
 */
import { Fragment, useMemo } from "react";
import { openInBrowser } from "../app/actions/hosts";
import { linkify, type CompiledRule } from "../app/ticketLinks";
import { t } from "../i18n";

export interface LinkedTextProps {
  text: string;
  rules: readonly CompiledRule[];
  /** false in the graph: each row is one tab stop (roving tabindex); the commit details offer the links to the keyboard. */
  focusable?: boolean;
}

export function LinkedText({ text, rules, focusable = true }: LinkedTextProps) {
  const parts = useMemo(() => linkify(text, rules), [text, rules]);
  return (
    <>
      {parts.map((part, index) =>
        part.kind === "text" ? (
          <Fragment key={index}>{part.text}</Fragment>
        ) : (
          <button
            key={index}
            type="button"
            tabIndex={focusable ? undefined : -1}
            data-ticket-link={part.ruleId}
            title={t("ui.ticketLink.open", { url: part.url })}
            className="inline cursor-pointer rounded-sm text-accent underline underline-offset-2 hover:brightness-110"
            onClick={(event) => {
              event.stopPropagation();
              void openInBrowser(part.url, t("ui.ticketLink.what"));
            }}
          >
            {part.text}
          </button>
        ),
      )}
    </>
  );
}
