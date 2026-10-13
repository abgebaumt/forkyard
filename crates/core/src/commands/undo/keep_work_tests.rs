//! Work created AFTER an action survives its undo. Submodule of `roundtrip_tests`: uses its
//! `Fx`.

use super::*;

/// "Discard all" → keep working → undo. The discarded change comes back, and whatever was
/// created since (new file, change to another file) stays in place.
#[tokio::test]
async fn undo_of_discard_keeps_work_done_afterwards() {
    let fx = Fx::new().await;
    fx.repo.commit_file("stationen.csv", "kürzel;name\nN;Nord\n", "Stationen");
    fx.repo.write_file("README.md", "verworfene Fassung\n");
    discard_paths(&fx.tc, fx.id(), None).await.unwrap();
    assert!(fx.porcelain().is_empty());

    fx.repo.write_file("notizen/nach-dem-verwerfen.txt", "entstand NACH dem Verwerfen\n");
    fx.repo.write_file("stationen.csv", "kürzel;name\nNEU;nach dem Verwerfen\n");
    fx.undo().await.unwrap();
    assert_eq!(fx.text("README.md"), "verworfene Fassung\n", "the discarded change is back");
    assert_eq!(fx.text("notizen/nach-dem-verwerfen.txt"), "entstand NACH dem Verwerfen\n", "the new file stays");
    assert_eq!(fx.text("stationen.csv"), "kürzel;name\nNEU;nach dem Verwerfen\n", "the new change stays");

    // Redo again discards only what the action had discarded.
    fx.redo().await.unwrap();
    assert_eq!(fx.text("README.md"), "# Test\n");
    assert!(fx.exists("notizen/nach-dem-verwerfen.txt"));
    assert_eq!(fx.text("stationen.csv"), "kürzel;name\nNEU;nach dem Verwerfen\n");
}

/// Same file, same place: undo refuses and touches nothing.
#[tokio::test]
async fn undo_of_discard_refuses_to_overwrite_newer_work_in_the_same_place() {
    let fx = Fx::new().await;
    fx.repo.write_file("README.md", "# Test\nAlte Änderung (wird verworfen)\n");
    discard_paths(&fx.tc, fx.id(), Some(vec!["README.md".into()])).await.unwrap();
    fx.repo.write_file("README.md", "# Test\nNeue Arbeit nach dem Verwerfen\n");

    let error = fx.undo().await.expect_err("undo must not replace the new work");
    assert_eq!(error.code, ErrorCode::DirtyWorktree, "{error:?}");
    assert!(error.message.contains("README.md") && error.message.contains("since this action"), "{}", error.message);
    assert_eq!(fx.text("README.md"), "# Test\nNeue Arbeit nach dem Verwerfen\n", "the file is untouched");
    assert_eq!(fx.peek().await.undo.map(|step| step.action).as_deref(), Some("discard"), "the step is still offered");
    assert!(fx.peek().await.redo.is_none(), "nothing has been undone");
}

/// Same file, different place: after undo both changes are in the file.
#[tokio::test]
async fn undo_of_discarded_hunk_merges_with_later_edits_elsewhere_in_the_file() {
    let fx = Fx::new().await;
    let original: String = (1..=40).map(|n| format!("Zeile {n}\n")).collect();
    fx.repo.commit_file("reihe.txt", &original, "Reihe");
    fx.repo.write_file("reihe.txt", original.replace("Zeile 38\n", "Zeile 38 – verworfen\n"));
    let FileDiff::Text(diff) = diff_file(&fx.tc, fx.id(), "reihe.txt".into(), DiffSource::Unstaged, None, None, None).await.unwrap() else {
        panic!("expected a text diff")
    };
    let selection = PatchSelection { path: "reihe.txt".into(), hunks: vec![HunkSelection { index: 0, lines: None }], expect: diff.token.clone().unwrap() };
    discard_patch(&fx.tc, fx.id(), selection).await.unwrap();
    assert_eq!(fx.text("reihe.txt"), original);

    fx.repo.write_file("reihe.txt", original.replace("Zeile 2\n", "Zeile 2 – NEU\n"));
    fx.undo().await.unwrap();
    let now = fx.text("reihe.txt");
    assert!(now.contains("Zeile 38 – verworfen\n"), "the discarded hunk is back: {now}");
    assert!(now.contains("Zeile 2 – NEU\n"), "the later change is still there: {now}");
}

/// Hard reset, stash pop and squash merge → keep working → undo.
#[tokio::test]
async fn undo_of_reset_pop_and_squash_keeps_work_done_afterwards() {
    let fx = Fx::new().await;
    let a = fx.repo.head();
    fx.repo.commit_file("b.txt", "b\n", "B");

    // Hard Reset
    fx.repo.write_file("README.md", "vor dem Reset geändert\n");
    reset_branch(&fx.tc, fx.id(), a.clone(), ResetMode::Hard).await.unwrap();
    fx.repo.write_file("nach-dem-reset.txt", "neu\n");
    fx.undo().await.unwrap();
    assert_eq!(fx.text("README.md"), "vor dem Reset geändert\n");
    assert!(fx.exists("b.txt") && fx.exists("nach-dem-reset.txt"));
    fx.repo.write_file("README.md", "# Test\n");
    fx.repo.remove_file("nach-dem-reset.txt");
    assert!(fx.porcelain().is_empty(), "{:?}", fx.porcelain());

    // Stash Pop
    fx.repo.write_file("README.md", "im Stash geparkt\n");
    stash_create(&fx.tc, fx.id(), util::new_id(), Some("geparkt".into()), None, true, None).await.unwrap();
    stash_pop(&fx.tc, fx.id(), 0).await.unwrap();
    fx.repo.write_file("nach-dem-pop.txt", "neu\n");
    fx.repo.write_file("b.txt", "nach dem Pop geändert\n");
    fx.undo().await.unwrap();
    assert_eq!(fx.lines(&["stash", "list", "--format=%gs"]), ["On main: geparkt"], "the stash is back in the list");
    assert_eq!(fx.text("README.md"), "# Test\n", "the change from the stash is gone again");
    assert_eq!(fx.text("nach-dem-pop.txt"), "neu\n");
    assert_eq!(fx.text("b.txt"), "nach dem Pop geändert\n");
    fx.repo.write_file("b.txt", "b\n");
    fx.repo.remove_file("nach-dem-pop.txt");

    // Squash merge
    fx.repo.checkout_new("feature");
    fx.repo.commit_file("feature.txt", "f\n", "Feature");
    fx.repo.checkout("main");
    merge_start(&fx.tc, fx.id(), "feature".into(), MergeMode::Squash).await.unwrap();
    assert_eq!(fx.porcelain(), ["A  feature.txt"]);
    fx.repo.write_file("nach-dem-squash.txt", "neu\n");
    fx.undo().await.unwrap();
    assert_eq!(fx.porcelain(), ["?? nach-dem-squash.txt"], "the squash is undone, the new file stays");
}

/// A file that is only ignored through a not yet committed line of .gitignore survives
/// "discard all" and the undo afterwards.
#[tokio::test]
async fn discard_everything_keeps_files_ignored_by_an_uncommitted_gitignore_line() {
    let fx = Fx::new().await;
    fx.repo.commit_file(".gitignore", "ausgabe/\n", "Ignorieren");
    fx.repo.write_file("geheim.env", "TOKEN=nicht-wiederbeschaffbar\n");
    fx.repo.write_file(".gitignore", "ausgabe/\ngeheim.env\n");
    fx.repo.write_file("README.md", "wird verworfen\n");
    assert_eq!(fx.porcelain(), [" M .gitignore", " M README.md"]);

    discard_paths(&fx.tc, fx.id(), None).await.unwrap();
    assert_eq!(fx.text("geheim.env"), "TOKEN=nicht-wiederbeschaffbar\n", "the ignored file stays in place when discarding");
    assert_eq!(fx.text("README.md"), "# Test\n");

    fx.undo().await.unwrap();
    assert_eq!(fx.text("geheim.env"), "TOKEN=nicht-wiederbeschaffbar\n", "and after undo as well");
    assert_eq!(fx.text(".gitignore"), "ausgabe/\ngeheim.env\n");
    assert_eq!(fx.porcelain(), [" M .gitignore", " M README.md"]);
}

/// A hard reset to a commit in which a file that is ignored today was still tracked overwrites
/// the local version – undo brings it back. A checkout of the same commit does not overwrite
/// it in the first place.
#[tokio::test]
async fn ignored_file_tracked_in_the_target_survives_reset_and_checkout() {
    let fx = Fx::new().await;
    let old = fx.repo.commit_file("config/lokal.env", "ALT=aus-der-historie\n", "versehentlich eingecheckt");
    fx.repo.git(&["rm", "-q", "--cached", "config/lokal.env"]);
    fx.repo.write_file(".gitignore", "config/lokal.env\n");
    fx.repo.commit("nicht mehr verfolgen");
    fx.repo.write_file("config/lokal.env", "GEHEIM=nur-hier\n");
    assert!(fx.porcelain().is_empty());

    reset_branch(&fx.tc, fx.id(), old.clone(), ResetMode::Hard).await.unwrap();
    assert_eq!(fx.text("config/lokal.env"), "ALT=aus-der-historie\n");
    fx.undo().await.unwrap();
    assert_eq!(fx.text("config/lokal.env"), "GEHEIM=nur-hier\n", "the local, ignored version is back");
    assert!(fx.porcelain().is_empty(), "{:?}", fx.porcelain());

    let error = branch_checkout(&fx.tc, fx.id(), old).await.expect_err("checkout must refuse");
    assert_eq!(error.code, ErrorCode::DirtyWorktree, "{error:?}");
    assert!(error.message.contains("lokal.env"), "{}", error.message);
    assert_eq!(fx.text("config/lokal.env"), "GEHEIM=nur-hier\n");
}

/// The undo entry exists before "discard all" deletes anything. If the action breaks off
/// midway (entry with the provisional state, one file already deleted, one still there),
/// undo brings everything back and leaves alone whatever is new in the meantime.
#[tokio::test]
async fn undo_entry_of_discard_works_after_a_crash_midway() {
    let fx = Fx::new().await;
    fx.repo.write_file("README.md", "ungesichert\n");
    fx.repo.write_file("viele/eins.txt", "1\n");
    fx.repo.write_file("viele/zwei.txt", "2\n");
    discard_paths(&fx.tc, fx.id(), None).await.unwrap();
    let entry = fx.top();
    assert!(entry.payload["resultSnapshot"].is_string(), "{}", entry.payload);

    let mut payload = entry.payload.clone();
    payload["resultSnapshot"] = serde_json::json!(fx.repo.head());
    u::update_payload(&fx.tc, &entry.id, &payload).unwrap();
    fx.repo.write_file("viele/zwei.txt", "2\n");
    fx.repo.write_file("neu-nach-dem-absturz.txt", "neu\n");

    fx.undo().await.unwrap();
    assert_eq!(fx.text("README.md"), "ungesichert\n");
    assert_eq!(fx.text("viele/eins.txt"), "1\n");
    assert_eq!(fx.text("viele/zwei.txt"), "2\n");
    assert!(fx.exists("neu-nach-dem-absturz.txt"));
}

/// With `core.autocrlf=true` a checkout would write every file with CRLF. Discarded files still
/// come back byte for byte – pure LF files, mixed line endings, CRLF.
#[tokio::test]
async fn undo_of_discard_brings_files_back_byte_for_byte_under_autocrlf() {
    let fx = Fx::new().await;
    fx.repo.git(&["config", "core.autocrlf", "true"]);
    let script: &[u8] = b"#!/bin/sh\necho eins\necho zwei\n";
    let mixed: &[u8] = b"eins\r\nzwei\ndrei\r\nvier\n";
    let windows: &[u8] = b"alpha\r\nbeta\r\n";
    let edited: &[u8] = b"# Test\nmit LF angeh\xc3\xa4ngt\nund noch eine\n";
    // Untracked: LF, mixed, CRLF. Tracked and modified: pure LF lines.
    fx.repo.write_file("skripte/lauf.sh", script);
    fx.repo.write_file("notizen/gemischt.txt", mixed);
    fx.repo.write_file("notizen/windows.txt", windows);
    fx.repo.write_file("README.md", edited);

    // Discard single files and bring them back.
    discard_paths(&fx.tc, fx.id(), Some(vec!["skripte/lauf.sh".into(), "notizen/gemischt.txt".into()])).await.unwrap();
    assert!(!fx.exists("skripte/lauf.sh") && !fx.exists("notizen/gemischt.txt"));
    fx.undo().await.unwrap();
    assert_eq!(fx.repo.read_file("skripte/lauf.sh"), script, "pure LF file byte-exact");
    assert_eq!(fx.repo.read_file("notizen/gemischt.txt"), mixed, "mixed line endings byte-exact");

    // Discard everything and bring it back.
    discard_paths(&fx.tc, fx.id(), None).await.unwrap();
    assert!(fx.porcelain().is_empty());
    fx.undo().await.unwrap();
    assert_eq!(fx.repo.read_file("skripte/lauf.sh"), script);
    assert_eq!(fx.repo.read_file("notizen/gemischt.txt"), mixed);
    assert_eq!(fx.repo.read_file("notizen/windows.txt"), windows);
    assert_eq!(fx.repo.read_file("README.md"), edited, "the modified, tracked file too");

    // Redo discards again; back once more – still the same bytes.
    fx.redo().await.unwrap();
    assert!(!fx.exists("skripte/lauf.sh"));
    fx.undo().await.unwrap();
    assert_eq!(fx.repo.read_file("skripte/lauf.sh"), script);
    assert_eq!(fx.repo.read_file("notizen/gemischt.txt"), mixed);
    assert_eq!(fx.repo.read_file("README.md"), edited);
}

#[test]
fn cat_file_batch_output_is_split_by_the_sizes_in_the_headers() {
    let out = b"1111 blob 5\nab\ncd\n2222 missing\n3333 blob 0\n\n4444 blob 3\nx\r\n\n";
    let parsed = u::parse_cat_file_batch_for_tests(out);
    assert_eq!(parsed, vec![Some(&b"ab\ncd"[..]), None, Some(&b""[..]), Some(&b"x\r\n"[..])]);
}
