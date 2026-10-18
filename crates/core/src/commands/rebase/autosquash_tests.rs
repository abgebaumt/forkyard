//! `rebase_plan_with(…, Some(true))`: Git's autosquash order, checked against Git's own
//! `rebase -i --autosquash` on a copy of the branch, then applied with `rebase_apply_with`.

use super::*;
use crate::testkit::{TestCore, TestRepo};

fn log(repo: &TestRepo, format: &str, range: &str) -> Vec<String> {
    repo.git(&["log", "--reverse", &format!("--format={format}"), range]).lines().map(str::to_string).collect()
}

/// Writes a file and commits it as Ada with author and committer date `date` (Git's raw format).
fn commit_at(repo: &TestRepo, file: &str, content: &str, message: &str, date: &str) -> String {
    repo.write_file(file, content);
    repo.commit_as(message, "Ada Lovelace", "ada@example.org", date)
}

/// `feature` on top of `base`: fixups by subject, by SHA prefix and by subject prefix, a fixup of a
/// fixup, a squash and a fixup whose target lies before the range; dated 2001 in +14:00, -12:00, +05:30.
fn fixture() -> (TestRepo, String) {
    let repo = TestRepo::with_commit();
    let base = commit_at(&repo, "a.txt", "a\n", "Grundlage für die Prüfung", "@978307200 +1400");
    repo.checkout_new("feature");
    commit_at(&repo, "p.txt", "p1\n", "Prüfung auf leere Eingaben", "@978307260 +1400");
    let p2 = commit_at(&repo, "m.txt", "m1\n", "Meldungen übersetzen", "@978307320 -1200");
    commit_at(&repo, "p.txt", "p2\n", "fixup! Prüfung auf leere Eingaben", "@978307380 +0000");
    commit_at(&repo, "c.txt", "c1\n", "Ausgabe als CSV", "@978307440 +0530");
    commit_at(&repo, "m.txt", "m2\n", &format!("fixup! {}", &p2[..8]), "@978307500 -1200");
    commit_at(&repo, "c.txt", "c2\n", "fixup! Ausgabe", "@978307560 +0530");
    commit_at(&repo, "p.txt", "p3\n", "fixup! fixup! Prüfung auf leere Eingaben", "@978307620 +1400");
    commit_at(&repo, "m2.txt", "zweite Meldung\n", "squash! Meldungen übersetzen", "@978307680 -1200");
    commit_at(&repo, "a.txt", "a2\n", "fixup! Grundlage für die Prüfung", "@978307740 +0100");
    (repo, base)
}

#[tokio::test]
async fn autosquash_plan_gives_the_same_history_as_git() {
    let (repo, base) = fixture();
    let range = format!("{base}..feature");
    let p2_fixup = format!("fixup! {}", &log(&repo, "%H", &range)[1][..8]);
    // Git's own autosquash on a copy of the branch is the oracle.
    repo.git(&["branch", "oracle", "feature"]);
    repo.git(&["checkout", "-q", "oracle"]);
    repo.git(&["-c", "sequence.editor=true", "-c", "core.editor=true", "rebase", "-q", "-i", "--autosquash", &base]);
    let oracle = format!("{base}..oracle");
    let (want_subjects, want_trees) = (log(&repo, "%s", &oracle), log(&repo, "%T", &oracle));
    repo.git(&["checkout", "-q", "feature"]);
    assert_eq!(want_subjects, ["Prüfung auf leere Eingaben", "Meldungen übersetzen", "Ausgabe als CSV", "fixup! Grundlage für die Prüfung"]);

    let tc = TestCore::new().await;
    let id = tc.open(&repo).await.repo.id;
    let RebasePlan::Ok { rows, .. } = rebase_plan_with(&tc, id.clone(), base.clone(), Some(true)).await.unwrap() else { panic!("expected a plan") };
    let plan: Vec<(&str, RebaseAction)> = rows.iter().map(|r| (r.summary.as_str(), r.action)).collect();
    assert_eq!(
        plan,
        vec![
            ("Prüfung auf leere Eingaben", RebaseAction::Pick),
            ("fixup! Prüfung auf leere Eingaben", RebaseAction::Fixup),
            ("fixup! fixup! Prüfung auf leere Eingaben", RebaseAction::Fixup),
            ("Meldungen übersetzen", RebaseAction::Pick),
            (p2_fixup.as_str(), RebaseAction::Fixup),
            ("squash! Meldungen übersetzen", RebaseAction::Squash),
            ("Ausgabe als CSV", RebaseAction::Pick),
            ("fixup! Ausgabe", RebaseAction::Fixup),
            ("fixup! Grundlage für die Prüfung", RebaseAction::Pick),
        ]
    );
    rebase_apply_with(&tc, id.clone(), base.clone(), rows, None).await.unwrap();
    assert_eq!(log(&repo, "%s", &range), want_subjects, "the same commits as Git's autosquash");
    assert_eq!(log(&repo, "%T", &range), want_trees, "with the same contents");
    assert_eq!(repo.git(&["log", "-1", "--format=%B", "feature~3"]), "Prüfung auf leere Eingaben", "fixup messages are dropped");
    assert_eq!(repo.git(&["log", "-1", "--format=%B", "feature~2"]), "Meldungen übersetzen\n\nsquash! Meldungen übersetzen", "a squash keeps both messages");
}

#[tokio::test]
async fn without_autosquash_nothing_moves_and_fixup_rows_keep_the_target_message() {
    let (repo, base) = fixture();
    let tc = TestCore::new().await;
    let id = tc.open(&repo).await.repo.id;
    let plain = rebase_plan_with(&tc, id.clone(), base.clone(), None).await.unwrap();
    assert_eq!(plain, rebase_plan(&tc, id.clone(), base.clone()).await.unwrap(), "without autosquash it is the plain plan");
    assert_eq!(rebase_plan_with(&tc, id.clone(), base.clone(), Some(false)).await.unwrap(), plain);
    let RebasePlan::Ok { rows, .. } = plain else { panic!("expected a plan") };
    assert!(rows.iter().all(|r| r.action == RebaseAction::Pick));
    // A fixup as the first row has nothing to fold into.
    let mut first = rows.clone();
    first[0].action = RebaseAction::Fixup;
    let error = rebase_apply_with(&tc, id.clone(), base.clone(), first, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NotAllowed);
    assert!(error.message.contains("fixup"), "{}", error.message);
    // A fixup row folds into the row above it: that one keeps its own message and gets the content.
    let mut folded = rows.clone();
    folded[2].action = RebaseAction::Fixup;
    rebase_apply_with(&tc, id.clone(), base.clone(), folded, None).await.unwrap();
    assert_eq!(log(&repo, "%s", &format!("{base}..feature")).len(), 8);
    assert_eq!(repo.git(&["log", "-1", "--format=%B", "feature~6"]), "Meldungen übersetzen");
    assert_eq!(repo.git(&["show", "feature~6:p.txt"]), "p2");
}
