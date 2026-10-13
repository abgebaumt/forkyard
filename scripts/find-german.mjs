// Searches source files for strings and JSX text that look German (umlauts or common
// German words). Comments are skipped.
// Helps with the move to i18n; a hit is a hint, not proof.
//
//   node scripts/find-german.mjs src/screens/Blame [more paths …]

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const WORDS =
  /\b(und|oder|nicht|kein|keine|der|die|das|den|dem|des|ein|eine|einen|ist|sind|wird|werden|mit|für|auf|aus|bei|nach|von|zum|zur|noch|schon|alle|neu|neue|Datei|Dateien|Abbrechen|Schließen|Öffnen|Speichern|Löschen|Zurück|Weiter|Fehler|Einstellungen|Änderungen|wählen|anzeigen|kopieren|hinzufügen|entfernen|umbenennen)\b/;
const UMLAUT = /[äöüÄÖÜß„“]/;

function files(path) {
  if (statSync(path).isDirectory()) return readdirSync(path).flatMap((name) => files(join(path, name)));
  return /\.(tsx?|mjs)$/.test(path) && !/\.test\./.test(path) ? [path] : [];
}

function stripComments(line, state) {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    if (state.block) {
      if (line.startsWith("*/", i)) {
        state.block = false;
        i++;
      }
      continue;
    }
    if (line.startsWith("/*", i)) {
      state.block = true;
      i++;
      continue;
    }
    if (line.startsWith("//", i) && !/:$/.test(out)) break;
    out += line[i];
  }
  return out;
}

let count = 0;
for (const root of process.argv.slice(2)) {
  for (const file of files(root)) {
    const state = { block: false };
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((raw, index) => {
        const line = stripComments(raw, state);
        const pieces = [...line.matchAll(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|`([^`\\]|\\.)*`|>([^<>{}]+)</g)].map((m) => m[0]);
        // JSX text alone on a line (without code characters).
        const bare = line.trim();
        if (bare && !/[{}()=;<>]/.test(bare)) pieces.push(bare);
        if (pieces.some((piece) => UMLAUT.test(piece) || WORDS.test(piece))) {
          count++;
          console.log(`${file}:${index + 1}: ${raw.trim().slice(0, 160)}`);
        }
      });
  }
}
console.error(`${count} hits`);
