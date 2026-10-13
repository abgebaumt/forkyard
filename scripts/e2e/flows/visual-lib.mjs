/**
 * Helpers for scripts/e2e/flows/visual.mjs (visual and text review).
 *
 * `auditPage(page)` runs in the page and collects what can be checked without looking:
 *   overflowX      horizontal overflow of the document (px)
 *   offscreen      dialogs, menus, messages, tooltips that stick out of the window
 *   clipped        interactive elements clipped by an ancestor with overflow:hidden
 *   unnamed        buttons/fields without an accessible name
 *   badText        texts containing undefined / null / NaN / [object
 *   cutText        text cut mid-word without "…" (overflow hidden, no ellipsis)
 *   ascii          German umlauts written as ae/oe/ue, ß as ss (word list; German UI only)
 *   plural         German singular/plural mismatches such as "1 Dateien", "3 Datei" (German UI only)
 *   english        English words (word list without Git terms; meant for the German UI)
 *   raw            raw technical output in messages (fatal:, os error, stack trace …)
 *   dates          English or US date formats (meant for the German UI)
 *
 * All of these are candidates: the caller filters them with an allow list and decides.
 */

export async function auditPage(page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const zoom = Number(document.documentElement.style.zoom || 1) || 1;
    const isVisible = (el) => {
      if (!(el instanceof Element)) return false;
      if (typeof el.checkVisibility === "function" && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const describe = (el) => {
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role");
      const label = el.getAttribute("aria-label") ?? el.getAttribute("title") ?? "";
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
      const screen = el.closest("[data-screen]")?.getAttribute("data-screen") ?? "";
      const cls = (el.getAttribute("class") ?? "").split(/\s+/).slice(0, 3).join(".");
      return `${screen ? `${screen} ` : ""}<${tag}${role ? ` role=${role}` : ""}${label ? ` "${label.slice(0, 50)}"` : ""}> ${text ? `"${text}"` : ""}${cls ? ` .${cls}` : ""}`.trim();
    };
    const rectOf = (el) => {
      const r = el.getBoundingClientRect();
      return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) };
    };
    const result = { overflowX: 0, offscreen: [], clipped: [], unnamed: [], badText: [], cutText: [], ascii: [], plural: [], english: [], raw: [], dates: [], lang: document.documentElement.lang || "" };

    // --- 1. Overflow -------------------------------------------------------------------------
    result.overflowX = Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, document.body.scrollWidth - document.body.clientWidth);

    // --- 2. Floating elements outside the window ---------------------------------------------
    const floating = document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tooltip"], [data-toast], [data-radix-popper-content-wrapper] > *');
    for (const el of floating) {
      if (!isVisible(el)) continue;
      const box = el.getBoundingClientRect();
      // What a scrolling ancestor clips does not stick out of the window (virtualised lists).
      const r = { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.overflowX === "visible" && style.overflowY === "visible") continue;
        const pr = parent.getBoundingClientRect();
        if (style.overflowX !== "visible") {
          r.left = Math.max(r.left, pr.left);
          r.right = Math.min(r.right, pr.right);
        }
        if (style.overflowY !== "visible") {
          r.top = Math.max(r.top, pr.top);
          r.bottom = Math.min(r.bottom, pr.bottom);
        }
      }
      if (r.left < -1 || r.top < -1 || r.right > vw / 1 + 1 || r.bottom > vh / 1 + 1) result.offscreen.push(`${describe(el)} @${JSON.stringify(rectOf(el))} window ${vw}×${vh}`);
    }

    // --- 3. Interactive elements that are clipped ----------------------------------------------
    const interactive = document.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="checkbox"], [role="switch"], [role="option"], [role="radio"], [role="combobox"]');
    for (const el of interactive) {
      if (!isVisible(el)) continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      const r = el.getBoundingClientRect();
      let clip = { l: 0, t: 0, r: vw, b: vh };
      let scrollable = false;
      let fixed = false;
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.position === "fixed") fixed = true;
        const ox = style.overflowX;
        const oy = style.overflowY;
        if (ox === "visible" && oy === "visible") continue;
        const pr = parent.getBoundingClientRect();
        const canScrollX = (ox === "auto" || ox === "scroll") && parent.scrollWidth > parent.clientWidth;
        const canScrollY = (oy === "auto" || oy === "scroll") && parent.scrollHeight > parent.clientHeight;
        const outX = r.left < pr.left - 2 || r.right > pr.right + 2;
        const outY = r.top < pr.top - 2 || r.bottom > pr.bottom + 2;
        if ((outX && canScrollX) || (outY && canScrollY)) {
          scrollable = true;
          break;
        }
        if (ox !== "visible") {
          clip.l = Math.max(clip.l, pr.left);
          clip.r = Math.min(clip.r, pr.right);
        }
        if (oy !== "visible") {
          clip.t = Math.max(clip.t, pr.top);
          clip.b = Math.min(clip.b, pr.bottom);
        }
      }
      if (scrollable) continue;
      const cutX = r.left < clip.l - 2 || r.right > clip.r + 2;
      const cutY = r.top < clip.t - 2 || r.bottom > clip.b + 2;
      if (cutX || cutY) result.clipped.push(`${describe(el)} @${JSON.stringify(rectOf(el))} visible up to ${JSON.stringify({ l: Math.round(clip.l), t: Math.round(clip.t), r: Math.round(clip.r), b: Math.round(clip.b) })}${fixed ? " (fixed)" : ""}`);
    }

    // --- 4. Without a name -------------------------------------------------------------------
    const nameOf = (el) => {
      const labelledby = el.getAttribute("aria-labelledby");
      if (labelledby) {
        const text = labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
        if (text) return text;
      }
      const aria = el.getAttribute("aria-label");
      if (aria && aria.trim()) return aria.trim();
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        const label = el.labels?.[0]?.textContent?.trim();
        if (label) return label;
        if (el.getAttribute("placeholder")) return el.getAttribute("placeholder");
        if (el.type === "hidden") return "(hidden)";
      }
      const text = (el.textContent ?? "").trim();
      if (text) return text;
      const title = el.getAttribute("title");
      if (title && title.trim()) return title.trim();
      const img = el.querySelector("img[alt], svg[aria-label]");
      if (img) return img.getAttribute("alt") ?? img.getAttribute("aria-label") ?? "";
      if (el.id) {
        const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim();
        if (forLabel) return forLabel;
      }
      return "";
    };
    for (const el of interactive) {
      if (!isVisible(el)) continue;
      if (el.closest('[aria-hidden="true"]') || el.getAttribute("tabindex") === "-1" && el.tagName === "TEXTAREA" && el.closest(".xterm")) continue;
      if (el.closest(".cm-editor, .xterm")) continue;
      if (!nameOf(el)) result.unnamed.push(`${describe(el)} @${JSON.stringify(rectOf(el))}`);
    }

    // --- 5. Collect texts ---------------------------------------------------------------------
    const CODE = ".cm-editor, .xterm, pre, code, canvas, [data-code], [data-diff-line], [data-terminal]";
    const texts = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = node.nodeValue?.replace(/\s+/g, " ").trim();
      if (!value) continue;
      const parent = node.parentElement;
      if (!parent || parent.closest("script, style, noscript")) continue;
      if (!isVisible(parent)) continue;
      texts.push({ value, el: parent, code: Boolean(parent.closest(CODE)) });
    }
    for (const el of document.querySelectorAll("[aria-label], [title], [placeholder], [alt], [data-tooltip]")) {
      if (!isVisible(el)) continue;
      for (const attr of ["aria-label", "title", "placeholder", "alt", "data-tooltip"]) {
        const value = el.getAttribute(attr);
        if (value && value.trim()) texts.push({ value: value.trim(), el, code: false, attr });
      }
    }
    const where = (entry) => `${entry.attr ? `[${entry.attr}] ` : ""}${describe(entry.el).slice(0, 110)}`;
    const push = (list, entry, hit) => list.push(`"${hit}" in "${entry.value.slice(0, 140)}" – ${where(entry)}`);

    const BAD = /\bundefined\b|\bnull\b|\bNaN\b|\[object |\bInfinity\b|\{\{|\}\}|\$\{|%s\b|%d\b|\bTODO\b|\bFIXME\b|lorem ipsum|\bxxx\b/i;
    const ASCII = /\b(fuer|ueber\w*|oeffn\w*|loesch\w*|aender\w*|zurueck\w*|hinzufueg\w*|waehl\w*|koenn\w*|moeg\w*|muess\w*|schluess\w*|\w*gueltig\w*|pruef\w*|\w*fuehr\w*|rueckg\w*|geaendert\w*|naechst\w*|spaeter|groess\w*|enthaelt|laeuft|laedt|erklaer\w*|bestaetig\w*|uebernehm\w*|uebersicht|eintraeg\w*|zusaetz\w*|vollstaend\w*|unterstuetz\w*|verfueg\w*|gewaehlt\w*|abhaeng\w*|aehnlich\w*|geloest|loesung\w*|oeffentlich\w*|schliessen|geschlossen_|ausserhalb|heisst|weiss|grosse?[nrs]?|aenderung\w*|geloescht\w*|ungueltig\w*|zurueckg\w*|haengt|faellt|wuerd\w*|waere|duerf\w*|moechte\w*|koennte\w*|natuerlich|tatsaechlich|gemaess|schliesslich|regelmaessig|Massnahme\w*|Groesse|Laenge|Hoehe|Faehigkeit|verknuepf\w*|ausgewaehlt\w*|rueckgaengig|Aenderungen|Schluessel|Eintraege|Vorschlaege|Zugaenge|benoetig\w*|noetig|moeglich\w*|unmoeglich|vorlaeufig|endgueltig|zuverlaessig|zulaessig|haeufig|kuerz\w*|laeng\w*|staerk\w*|schwaech\w*|erhaelt|behaelt|traegt|schlaegt|fehlgeschlagen_)\b/i;
    const PLURAL_ONE = /(?<![\d.,:#/-])\b1 (Dateien|Commits|Branches|Tags|Stashes|Einträge|Zeilen|Remotes|Änderungen|Konflikte|Repositories|Worktrees|Minuten|Stunden|Tagen|Tage|Monaten|Monate|Jahren|Jahre|Sekunden|Elemente|Hunks|Tabs|Autoren|Schritte|Meldungen|Befehle|Ergebnisse|Kommentare|Labels|Pull Requests|Issues|Ordner_|Muster_|Schlüssel_|Konten|Profile|Gruppen|Fehler_|Versuche|Blöcke|Stellen|Wörter|Bytes|Objekte|Eltern_|Kinder|Wochen)\b/;
    const PLURAL_MANY = /(?<![\d.,:#/-])\b(0|[2-9]|\d{2,}) (Datei|Eintrag|Zeile|Änderung|Konflikt|Minute|Stunde|Sekunde|Monat|Jahr|Woche|Element|Schritt|Meldung|Befehl|Ergebnis|Kommentar|Gruppe|Profil|Konto|Versuch|Block|Stelle|Wort|Objekt|Autor|Remote-Branch|Commit|Branch|Stash|Tab|Hunk)\b(?![-/.])/;
    const ENGLISH = /\b(Cancel|Delete|Save|Loading|Failed|Error|Errors|Settings|Close|Open|Search|Remove|Rename|Copy|Paste|Yes|No|Apply|Create|Edit|Add|Next|Previous|Back|Done|Retry|Show|Hide|Unknown|Warning|Success|Folder|Changes|Unstaged|Staged|Untracked|Modified|Deleted|Renamed|Added|Author|Date|Selected|None|All|Default|Enabled|Disabled|not found|No such|Permission denied|Invalid|Missing|Empty|Preview|Options|Update|Submit|expired|Unauthorized|Forbidden|Bad credentials|Not Found|Click|Select|Choose|Password|Username|Sign in|Login|Logout|Help|About|General|Appearance|Notifications|Experimental|Reload|Refresh|Clear|Reset to|Unable|Cannot|Could not|couldn't|doesn't|does not|is not|already exists|required|Never|Always|Today|Yesterday|ago|minutes?|hours?|days?|weeks?|months?|years?|seconds?|bytes|lines?|items?|results?|No results|Nothing|Something|went wrong|Please|Try again|Learn more|Read more|Unsaved|Saved|Saving|Fetching|Pushing|Pulling|Cloning|Receiving|Resolving|Counting|Compressing|Writing|Unpacking|Enumerating|Updating|remote:|Untitled|New File|View|Window|Light|Dark|Font|Size|Width|Height|Right|Top|Bottom|True|False|On|Off)\b/;
    const RAW = /\bfatal:|\berror:|\bhint:|\bwarning:|exit code|exit status|\bstderr\b|\bstdout\b|Traceback|panicked|\.rs:\d+|os error|\(os error|ENOENT|EACCES|EPERM|0x[0-9a-f]{6,}|Error \{|Some\(|Err\(|Ok\(|\bat \w+ \(|TypeError|ReferenceError|SyntaxError|Uncaught|invoke|tauri|serde|unwrap|JSON\.parse|status code|HTTP \d{3}|errno|\\\\\?\\|\bEOF\b|refs\/heads\/|refs\/remotes\/|refs\/tags\//;
    const DATES = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b(January|February|March|April|May|June|July|August|September|October|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b|\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}\b|\b\d{1,2}:\d{2} ?(AM|PM)\b|\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

    for (const entry of texts) {
      if (entry.code) continue;
      const value = entry.value;
      let hit;
      if ((hit = BAD.exec(value))) push(result.badText, entry, hit[0]);
      if ((hit = ASCII.exec(value))) push(result.ascii, entry, hit[0]);
      if ((hit = PLURAL_ONE.exec(value))) push(result.plural, entry, hit[0]);
      if ((hit = PLURAL_MANY.exec(value))) push(result.plural, entry, hit[0]);
      if ((hit = ENGLISH.exec(value))) push(result.english, entry, hit[0]);
      if ((hit = DATES.exec(value))) push(result.dates, entry, hit[0]);
      const inMessage = entry.el.closest('[data-toast], [role="alert"], [role="alertdialog"], [role="dialog"], [role="status"], [data-banner], [data-error]');
      if (inMessage && (hit = RAW.exec(value))) push(result.raw, entry, hit[0]);
    }

    // --- 6. Text cut without "…" ---------------------------------------------------------------
    const seen = new Set();
    for (const entry of texts) {
      if (entry.attr || entry.code) continue;
      const el = entry.el;
      if (seen.has(el)) continue;
      seen.add(el);
      const style = getComputedStyle(el);
      if (el.closest('[aria-hidden="true"]')) continue;
      const hiddenX = style.overflowX === "hidden" || style.overflowX === "clip";
      const hiddenY = style.overflowY === "hidden" || style.overflowY === "clip";
      if (el.classList.contains("sr-only") || el.closest(".sr-only")) continue;
      if (hiddenX && el.scrollWidth > el.clientWidth + 1 && style.textOverflow !== "ellipsis") {
        result.cutText.push(`horizontal ${el.scrollWidth - el.clientWidth}px: ${describe(el)} @${JSON.stringify(rectOf(el))}`);
      } else if (hiddenY && el.scrollHeight > el.clientHeight + 3 && !style.webkitLineClamp?.match(/\d/) && style.display !== "-webkit-box") {
        result.cutText.push(`vertical ${el.scrollHeight - el.clientHeight}px: ${describe(el)} @${JSON.stringify(rectOf(el))}`);
      }
    }
    void zoom;
    return result;
  });
}

/** All visible texts of messages (toasts, alerts, alert dialogs) – to read them "as a user". */
export async function visibleMessages(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[data-toast], [role="alert"], [role="alertdialog"]')) {
      const text = (el.innerText ?? "").replace(/\s+/g, " ").trim();
      if (text) out.push({ kind: el.getAttribute("data-toast") ? `toast:${el.getAttribute("data-toast")}` : el.getAttribute("role"), text });
    }
    return out;
  });
}

export const CATEGORIES = ["offscreen", "clipped", "unnamed", "badText", "cutText", "ascii", "plural", "english", "raw", "dates"];
