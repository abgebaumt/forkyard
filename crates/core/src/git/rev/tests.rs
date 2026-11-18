//! Pins the one set of revision rules every command uses.

use super::*;
use crate::testkit::{TestCore, TestRepo};

#[test]
fn string_rules() {
    assert!(is_sha(&"a".repeat(40)) && is_sha(&"F".repeat(64)));
    assert!(!is_sha(&"a".repeat(39)) && !is_sha(&"g".repeat(40)) && !is_sha(&"a".repeat(50)));
    assert!(is_sha_prefix("abcd") && is_sha_prefix(&"a".repeat(64)));
    assert!(!is_sha_prefix("abc") && !is_sha_prefix(&"a".repeat(65)) && !is_sha_prefix("main"));

    assert_eq!(short("0123456789abcdef"), "0123456");
    assert_eq!(short("abc"), "abc");
    assert_eq!(short("ääääääääää"), "äääääää", "never cuts inside a character");

    for ok in ["main", "HEAD~2", "a..b", "v1.0^{commit}", "feature/x"] {
        assert!(is_rev_arg(ok), "{ok}");
    }
    for bad in ["", "-x", "--output=/tmp/x", "main\n", "a\0b", "\x1b[31m"] {
        assert!(!is_rev_arg(bad), "{bad:?}");
    }

    assert_eq!(short_ref_name("refs/remotes/origin/main"), "origin/main");
    assert_eq!(short_ref_name("refs/heads/a/b"), "a/b");
    assert_eq!(short_ref_name("refs/tags/v1"), "v1");
    assert_eq!(short_ref_name("refs/notes/x"), "refs/notes/x");

    assert!(could_be_branch_name("main") && could_be_branch_name("feature/x"));
    for expr in [
        "refs/heads/main",
        "HEAD",
        "FETCH_HEAD",
        "ORIG_HEAD",
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "HEAD~1",
        "a^",
        "a..b",
        "@{u}",
        "a:b",
        "a b",
    ] {
        assert!(!could_be_branch_name(expr), "{expr}");
    }
}

#[tokio::test]
async fn resolving_prefers_the_local_branch_and_refuses_options() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let first = repo.head();
    let id = tc.open(&repo).await.repo.id;
    // A tag `main` on the first commit, the branch `main` one commit further.
    repo.git(&["tag", "main", &first]);
    let second = repo.commit_file("b.txt", "b\n", "second");
    let tag = repo.git(&["rev-parse", "refs/tags/main"]);
    assert_eq!(tag, first);

    assert_eq!(resolve_commit(&tc, &id, "main").await.unwrap(), second, "local branch before the tag");
    assert_eq!(resolve_commit(&tc, &id, " main ").await.unwrap(), second, "trimmed");
    assert_eq!(resolve_commit(&tc, &id, "refs/tags/main").await.unwrap(), first);
    assert_eq!(resolve_commit(&tc, &id, "HEAD~1").await.unwrap(), first);
    assert_eq!(resolve_commit(&tc, &id, &first[..8]).await.unwrap(), first, "SHA prefix");
    assert_eq!(resolve_commit(&tc, &id, &second).await.unwrap(), second);

    for bad in ["", "-h", " --all", "ma\nin", "nope"] {
        assert_eq!(try_resolve_commit(&tc, &id, bad).await.unwrap(), None, "{bad:?}");
        let err = resolve_commit(&tc, &id, bad).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound, "{bad:?}");
    }
    // A tree is no commit.
    let tree = repo.git(&["rev-parse", "HEAD^{tree}"]);
    assert_eq!(try_resolve_commit(&tc, &id, &tree).await.unwrap(), None);
    assert_eq!(rev_parse(&tc, &id, &tree).await.unwrap(), Some(tree), "rev_parse does not peel");
    assert_eq!(rev_parse(&tc, &id, "-h").await.unwrap(), None);
    assert_eq!(rev_parse(&tc, &id, "refs/heads/nope").await.unwrap(), None);
}

#[tokio::test]
async fn ancestry_is_false_for_missing_commits() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let first = repo.head();
    let second = repo.commit_file("b.txt", "b\n", "second");
    let id = tc.open(&repo).await.repo.id;

    assert!(is_ancestor(&tc, &id, &first, &second).await.unwrap());
    assert!(is_ancestor(&tc, &id, &first, &first).await.unwrap());
    assert!(!is_ancestor(&tc, &id, &second, &first).await.unwrap());
    assert!(!is_ancestor(&tc, &id, &first, "refs/heads/gone").await.unwrap(), "missing → false");
    assert!(!is_ancestor(&tc, &id, "-h", &second).await.unwrap(), "no option injection");
}
