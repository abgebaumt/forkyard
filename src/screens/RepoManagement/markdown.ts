/**
 * README as HTML for the preview. The content comes from a repository and is untrusted:
 *
 * 1. marked turns Markdown into HTML (raw HTML in the Markdown stays in place),
 * 2. DOMPurify lets only a short list of harmless elements and attributes through – no scripts,
 *    no event attributes, no frames, forms, styles, media,
 * 3. a second pass in a detached document (DOMParser loads nothing and executes nothing) strips
 *    links of their target and replaces images with placeholders. So the app's document never gets
 *    an <img> that could fetch something from the network, and no link that navigates.
 */
import DOMPurify from "dompurify";
import { Marked } from "marked";
import { t } from "../../i18n";

const markdown = new Marked({ gfm: true, breaks: false });

const ALLOWED_TAGS = [
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "hr", "blockquote", "pre", "code", "kbd", "samp", "var",
  "em", "strong", "b", "i", "u", "s", "del", "ins", "sub", "sup", "mark", "small", "abbr", "q", "cite",
  "ul", "ol", "li", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
  "a", "img", "input", "details", "summary", "div", "span",
];

const ALLOWED_ATTR = ["href", "src", "alt", "title", "align", "colspan", "rowspan", "start", "type", "checked", "open"];

/** Nothing beyond this is rendered; the core returns up to 1 MB. */
export const README_PREVIEW_LIMIT = 200_000;

/** Embedded raster images need no network and may stay. */
const INLINE_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i;

export interface RenderedReadme {
  html: string;
  /** The text was longer than README_PREVIEW_LIMIT. */
  truncated: boolean;
  /** Images that were replaced by a placeholder. */
  blockedImages: number;
}

/** Target of a link if it can be opened in the system browser; otherwise null. */
export function externalTarget(href: string): string | null {
  const value = href.trim();
  if (!/^(https?:\/\/|mailto:)/i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:" ? url.href : null;
  } catch {
    return null;
  }
}

export function renderReadme(source: string): RenderedReadme {
  const truncated = source.length > README_PREVIEW_LIMIT;
  const text = truncated ? source.slice(0, README_PREVIEW_LIMIT) : source;
  const raw = markdown.parse(text, { async: false });

  const clean = DOMPurify.sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    RETURN_TRUSTED_TYPE: false,
  });

  const doc = new DOMParser().parseFromString(`<!doctype html><body>${clean}`, "text/html");
  let blockedImages = 0;

  for (const image of Array.from(doc.body.querySelectorAll("img"))) {
    const src = (image.getAttribute("src") ?? "").trim();
    const alt = (image.getAttribute("alt") ?? "").trim();
    if (INLINE_IMAGE.test(src)) {
      for (const attribute of Array.from(image.attributes)) {
        if (attribute.name !== "src" && attribute.name !== "alt") image.removeAttribute(attribute.name);
      }
      continue;
    }
    blockedImages += 1;
    const remote = /^(https?:)?\/\//i.test(src);
    const placeholder = doc.createElement("span");
    placeholder.setAttribute("data-readme-image", remote ? "remote" : "local");
    placeholder.setAttribute("title", remote ? t("repos.readme.imageRemote") : t("repos.readme.imageLocal"));
    placeholder.textContent = alt ? t("repos.readme.imageAlt", { alt }) : t("repos.readme.image");
    image.replaceWith(placeholder);
  }

  for (const link of Array.from(doc.body.querySelectorAll("a"))) {
    const target = externalTarget(link.getAttribute("href") ?? "");
    for (const attribute of Array.from(link.attributes)) link.removeAttribute(attribute.name);
    if (target) {
      // No href: the link cannot navigate. The preview asks first and hands it to the system browser.
      link.setAttribute("data-href", target);
      link.setAttribute("role", "link");
      link.setAttribute("tabindex", "0");
      link.setAttribute("title", target);
    } else {
      link.setAttribute("data-inert", "");
    }
  }

  // Task lists: the checkbox as a character, not a form field.
  for (const input of Array.from(doc.body.querySelectorAll("input"))) {
    if (input.getAttribute("type") !== "checkbox") {
      input.remove();
      continue;
    }
    const done = input.hasAttribute("checked");
    const box = doc.createElement("span");
    box.setAttribute("data-readme-task", done ? "done" : "open");
    box.setAttribute("role", "img");
    box.setAttribute("aria-label", done ? t("repos.readme.taskDone") : t("repos.readme.taskOpen"));
    input.replaceWith(box);
  }

  return { html: doc.body.innerHTML, truncated, blockedImages };
}
