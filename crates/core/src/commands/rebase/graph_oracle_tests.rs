//! The todo list the graph gestures produce, applied with `rebase_apply`, gives the same history as
//! Git's own `git rebase -i` with that todo list.

use super::*;
use crate::model::RebaseAction::{Drop, Fixup, Pick, Squash};
use crate::testkit::{TestCore, TestRepo};

/// Hand-written, identical to `combined gesture` in src/app/rebasePlan/gestures.test.ts.
const TODO: [(&str, RebaseAction); 5] = [("c1", Pick), ("c4", Squash), ("c5", Pick), ("c2", Fixup), ("c3", Drop)];

#[tokio::test]
async fn graph_gestures_match_git_rebase_i() {
    let repo = TestRepo::with_commit();
    let base = repo.head();
    repo.checkout_new("feature");
    let files = ["a.txt", "b.txt", "c.txt", "d.txt", "e ü.txt"];
    let shas: HashMap<String, String> = files
        .iter()
        .enumerate()
        .map(|(i, file)| (format!("c{}", i + 1), repo.commit_file(file, format!("{i}\n"), &format!("c{}", i + 1))))
        .collect();
    repo.git(&["branch", "oracle", "feature"]);

    // Oracle: Git's own interactive rebase on `oracle`, the todo list put in place by the sequence editor.
    repo.git(&["checkout", "-q", "oracle"]);
    let todo: String = TODO.iter().map(|(name, action)| format!("{} {}\n", git_word(*action), shas[*name])).collect();
    let todo_file = repo.temp_dir().join("todo");
    std::fs::write(&todo_file, todo).unwrap();
    let editor = format!("cp '{}'", todo_file.display());
    repo.git(&["-c", &format!("sequence.editor={editor}"), "-c", "core.editor=true", "rebase", "-q", "-i", &base]);
    repo.git(&["checkout", "-q", "feature"]);

    // App: the same rows through `rebase_apply`.
    let tc = TestCore::new().await;
    let id = tc.open(&repo).await.repo.id;
    let RebasePlan::Ok { rows, .. } = rebase_plan(&tc, id.clone(), base.clone()).await.unwrap() else { panic!("no plan") };
    let rows = TODO
        .iter()
        .map(|(name, action)| {
            let row = rows.iter().find(|r| r.sha == shas[*name]).unwrap();
            RebasePlanRow { action: *action, message: None, ..row.clone() }
        })
        .collect();
    rebase_apply(&tc, id.clone(), base.clone(), rows).await.unwrap();

    // Trees, subjects and whole messages (the squash joins the messages of c1 and c4 like Git does).
    let log = |format: &str, branch: &str| repo.git(&["log", "--reverse", &format!("--format={format}"), &format!("{base}..{branch}")]);
    assert_eq!(log("%T %s", "feature"), log("%T %s", "oracle"));
    assert_eq!(log("%B", "feature"), log("%B", "oracle"));
    assert_eq!(log("%s", "feature").lines().count(), 2);
}

fn git_word(action: RebaseAction) -> &'static str {
    match action {
        Pick => "pick",
        RebaseAction::Reword => "reword",
        Squash => "squash",
        Fixup => "fixup",
        Drop => "drop",
    }
}
