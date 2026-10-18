/**
 * The app window never scrolls. html, body, #root and the shell's layout containers clip their
 * content (src/styles/app.css), but the viewport and any `overflow: hidden` fallback can still be
 * scrolled by script: scrollIntoView(), focus() without preventScroll, the browser bringing the
 * focused element into view, a text selection dragged past the window edge. Whatever moves one of
 * them is put back to 0 at once – before the next frame is painted.
 *
 * Real scroll areas (lists, editors, the panels' contents) are not affected.
 */

/** Elements of the frame that must stay at scroll position 0. */
function isPinned(target: EventTarget | null, doc: Document): Element | null {
  if (target === doc) return doc.scrollingElement ?? doc.documentElement;
  if (!target || !("hasAttribute" in target)) return null;
  const element = target as Element;
  if (element === doc.scrollingElement || element === doc.documentElement || element === doc.body || element === doc.getElementById("root")) return element;
  return element.hasAttribute("data-no-scroll") ? element : null;
}

/** Call once at startup. Returns the function that removes the guard again (tests). */
export function installScrollPin(doc: Document = document): () => void {
  const onScroll = (event: Event) => {
    const element = isPinned(event.target, doc);
    if (!element) return;
    if (element.scrollTop !== 0) element.scrollTop = 0;
    if (element.scrollLeft !== 0) element.scrollLeft = 0;
  };
  // "scroll" does not bubble; in the capture phase the document sees it for every element.
  doc.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => doc.removeEventListener("scroll", onScroll, { capture: true });
}
