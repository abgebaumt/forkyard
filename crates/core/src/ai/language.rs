//! The language of a repository's commit messages (Grundregel 6: texts for the repository in its
//! language, recognised from the last 50 commit subjects). A small word vote, no dictionary: each
//! subject votes for the language whose distinctive short words it uses most (a conventional
//! prefix such as `fix:` or `feat(api)!:` does not count; ä, ö, ü or ß count once for German; a
//! tie votes for nobody). The repository's language is the one with more than half of at least
//! three votes; otherwise `None`, and the prompt lets the model follow the example subjects.

use std::sync::OnceLock;

use regex::Regex;

/// Language names as the prompt uses them, with words that hardly occur in the other four.
const LANGUAGES: [(&str, &[&str]); 5] = [
    (
        "English",
        &[
            "the", "and", "for", "with", "from", "into", "when", "add", "adds", "added", "fix", "fixes", "fixed", "update", "updates", "updated", "remove", "removes",
            "removed", "use", "make", "allow", "support", "improve", "refactor", "rename", "move", "bump", "should", "not", "of", "to", "on",
        ],
    ),
    (
        "German",
        &[
            "der", "die", "das", "und", "für", "mit", "von", "zum", "zur", "im", "auf", "nicht", "ein", "eine", "einen", "den", "dem", "beim", "bei", "aus", "nach", "ist",
            "wenn", "statt", "ohne", "über", "füge", "behebe", "entferne", "aktualisiere", "hinzu", "neu", "neue", "neuer", "angelegt", "ergänzt", "korrigiert", "entfernt",
            "geändert", "überarbeitet", "behoben",
        ],
    ),
    (
        "French",
        &["les", "du", "et", "pour", "avec", "dans", "une", "sur", "ajout", "ajoute", "ajouter", "corrige", "correction", "supprime", "suppression", "mise", "jour", "à", "pas"],
    ),
    ("Spanish", &["el", "los", "las", "del", "y", "para", "añade", "agrega", "elimina", "actualiza", "corregido", "nuevo", "nueva", "cuando", "sin", "más", "también"]),
    ("Dutch", &["het", "een", "voor", "met", "van", "niet", "toevoegen", "toegevoegd", "verwijderd", "aangepast", "bijgewerkt", "opgelost", "bij", "naar", "ook", "wanneer"]),
];
const GERMAN: usize = 1;
/// Fewer subjects with a clear language say nothing about the repository.
pub const MIN_VOTES: usize = 3;

fn conventional_prefix() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-z]+(\([^)]*\))?!?:\s*").expect("valid pattern"))
}

fn vote(subject: &str) -> Option<usize> {
    let lower = subject.trim().to_lowercase();
    let text = conventional_prefix().replace(&lower, "");
    let mut scores = [0usize; LANGUAGES.len()];
    for word in text.split(|c: char| !c.is_alphabetic()).filter(|word| !word.is_empty()) {
        for (index, (_, words)) in LANGUAGES.iter().enumerate() {
            if words.contains(&word) {
                scores[index] += 1;
            }
        }
    }
    if text.contains(['ä', 'ö', 'ü', 'ß']) {
        scores[GERMAN] += 1;
    }
    let best = *scores.iter().max()?;
    if best == 0 || scores.iter().filter(|score| **score == best).count() > 1 {
        return None;
    }
    scores.iter().position(|score| *score == best)
}

/// The language one subject is clearly written in, if its words say so.
pub fn subject_language(subject: &str) -> Option<&'static str> {
    vote(subject).map(|index| LANGUAGES[index].0)
}

/// The language of the repository's commit messages, from its newest subjects.
pub fn detect(subjects: &[String]) -> Option<&'static str> {
    let mut votes = [0usize; LANGUAGES.len()];
    for index in subjects.iter().filter_map(|subject| vote(subject)) {
        votes[index] += 1;
    }
    let total: usize = votes.iter().sum();
    let (best, count) = votes.iter().copied().enumerate().max_by_key(|(index, count)| (*count, std::cmp::Reverse(*index)))?;
    (total >= MIN_VOTES && count * 2 > total).then_some(LANGUAGES[best].0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subjects(list: &[&str]) -> Vec<String> {
        list.iter().map(|subject| subject.to_string()).collect()
    }

    #[test]
    fn the_language_of_clear_histories_is_recognised() {
        let cases: [(&str, &[&str]); 5] = [
            ("German", &["Projekt für das Messnetz angelegt", "Liste der Stationen", "Vergleich der Tagesmittel zweier Stationen", "CSV-Export für den Vergleich"]),
            ("English", &["feat(api): add the export endpoint", "fix: handle empty input in the parser", "chore: bump serde to 1.0.200", "docs: update the README for 1.1"]),
            ("French", &["Ajoute la page de connexion", "Corrige le calcul des totaux pour les mois", "Mise à jour des dépendances"]),
            ("Spanish", &["Añade la página de inicio", "Elimina los archivos temporales", "Actualiza las dependencias del proyecto"]),
            ("Dutch", &["Knop voor het exporteren toegevoegd", "Fout bij het opslaan opgelost", "Teksten van de instellingen aangepast"]),
        ];
        for (expected, list) in cases {
            assert_eq!(detect(&subjects(list)), Some(expected), "{list:?}");
        }
    }

    #[test]
    fn conventional_prefixes_do_not_count_as_english() {
        assert_eq!(subject_language("fix: Fehler beim Speichern behoben"), Some("German"));
        assert_eq!(subject_language("feat(export)!: Export nach CSV"), Some("German"));
        assert_eq!(detect(&subjects(&["fix: Fehler beim Speichern behoben", "feat: Export nach CSV", "fix: Absturz bei leerer Liste"])), Some("German"));
    }

    #[test]
    fn unclear_histories_have_no_language() {
        assert_eq!(detect(&subjects(&["WIP", "wip", "asdf", "v1.2.0"])), None, "no words to go by");
        assert_eq!(detect(&subjects(&["Liste der Stationen", "CSV-Export für den Vergleich"])), None, "fewer than three votes");
        assert_eq!(
            detect(&subjects(&["Liste der Stationen", "CSV-Export für den Vergleich", "Vergleich der Tagesmittel", "add the parser", "fix the build", "update the docs"])),
            None,
            "a tie is no majority"
        );
        assert_eq!(detect(&[]), None);
        assert_eq!(subject_language("Release 2.0"), None);
    }

    #[test]
    fn the_majority_wins_and_umlauts_count_for_german() {
        assert_eq!(
            detect(&subjects(&["Liste der Stationen", "CSV-Export für den Vergleich", "Vergleich der Tagesmittel", "Projekt für das Messnetz angelegt", "add the parser", "fix the build"])),
            Some("German")
        );
        assert_eq!(subject_language("Größere Schrift"), Some("German"), "only the umlaut decides here");
        assert_eq!(subject_language("ÜBERARBEITUNG DER HILFE"), Some("German"), "upper case is lowered first");
    }
}
