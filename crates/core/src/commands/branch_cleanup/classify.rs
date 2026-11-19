//! The pure classification of one branch from its facts: reasons, class, listed or not.

use crate::model::{BranchCleanupClass, BranchCleanupReason};

/// Protected unless the repository says otherwise; `*` also crosses `/`.
pub(crate) const DEFAULT_PROTECTED: [&str; 5] = ["main", "master", "develop", "release/*", "hotfix/*"];

const DAY: i64 = 86_400;

/// Whether `name` matches a default or an own pattern (whole name; only `*` is a wildcard).
pub(crate) fn is_protected(name: &str, own: &[String]) -> bool {
    DEFAULT_PROTECTED.iter().copied().chain(own.iter().map(String::as_str)).any(|pattern| glob_matches(pattern, name))
}

/// `*`-only glob, anchored at both ends: the pieces between the stars must appear in order.
/// ASCII case-insensitive (refs are case-insensitive on Windows; protecting more is the safe side).
fn glob_matches(pattern: &str, name: &str) -> bool {
    let (pattern, name) = (pattern.to_ascii_lowercase(), name.to_ascii_lowercase());
    let mut pieces = pattern.split('*');
    let first = pieces.next().unwrap_or_default();
    let Some(mut rest) = name.strip_prefix(first) else { return false };
    let mut pieces: Vec<&str> = pieces.collect();
    let Some(last) = pieces.pop() else { return rest.is_empty() };
    for piece in pieces {
        match rest.find(piece) {
            Some(at) => rest = &rest[at + piece.len()..],
            None => return false,
        }
    }
    rest.ends_with(last)
}

/// What the host says about the branch's pull request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PrFact {
    /// PR data not loaded.
    Unknown,
    None,
    /// Any pull request that is not merged.
    Open,
    Merged {
        number: u64,
        commits_after_head: bool,
    },
}

#[derive(Debug, Clone)]
pub(crate) struct BranchFacts {
    pub name: String,
    pub merged: bool,
    pub unmerged: u32,
    pub unpushed: u32,
    pub upstream_gone: bool,
    /// Unix seconds of the tip's committer date.
    pub committed_at: i64,
    pub worktree: bool,
    pub protected: bool,
    pub pr: PrFact,
}

/// Class and reasons, or `None` if nothing suggests deleting the branch.
pub(crate) fn classify(facts: &BranchFacts, now: i64, stale_days: u32) -> Option<(BranchCleanupClass, Vec<BranchCleanupReason>)> {
    use BranchCleanupReason as R;
    let stale = now - facts.committed_at > i64::from(stale_days) * DAY;
    let pr_merged = match facts.pr {
        PrFact::Merged { number, .. } => Some(number),
        _ => None,
    };
    if !(facts.merged || pr_merged.is_some() || stale || facts.upstream_gone) {
        return None;
    }
    let mut reasons = Vec::new();
    let mut add = |on: bool, reason: R| {
        if on {
            reasons.push(reason);
        }
    };
    add(facts.merged, R::Merged);
    if let Some(number) = pr_merged {
        add(true, R::PrMerged { number });
    }
    add(facts.upstream_gone, R::UpstreamGone);
    add(stale, R::Stale);
    add(facts.pr == PrFact::None, R::NoPr);
    add(!facts.merged && facts.unmerged > 0, R::Unmerged { count: facts.unmerged });
    add(facts.unpushed > 0, R::Unpushed { count: facts.unpushed });
    add(facts.worktree, R::Worktree);
    add(facts.protected, R::Protected);
    let class = if facts.worktree || facts.protected {
        BranchCleanupClass::Blocked
    } else if facts.merged || matches!(facts.pr, PrFact::Merged { commits_after_head: false, .. }) {
        BranchCleanupClass::Safe
    } else {
        BranchCleanupClass::Review
    };
    Some((class, reasons))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_767_225_600 + 30 * DAY;

    fn facts(name: &str) -> BranchFacts {
        BranchFacts {
            name: name.into(),
            merged: false,
            unmerged: 1,
            unpushed: 0,
            upstream_gone: false,
            committed_at: NOW - DAY,
            worktree: false,
            protected: false,
            pr: PrFact::None,
        }
    }

    #[test]
    fn reasons_come_in_the_fixed_order_and_decide_the_class() {
        use BranchCleanupReason as R;
        let all = BranchFacts {
            merged: false,
            unmerged: 3,
            unpushed: 2,
            upstream_gone: true,
            committed_at: NOW - 100 * DAY,
            worktree: true,
            protected: true,
            pr: PrFact::Merged { number: 20, commits_after_head: false },
            ..facts("ä/alles")
        };
        assert_eq!(
            classify(&all, NOW, 90),
            Some((
                BranchCleanupClass::Blocked,
                vec![
                    R::PrMerged { number: 20 },
                    R::UpstreamGone,
                    R::Stale,
                    R::Unmerged { count: 3 },
                    R::Unpushed { count: 2 },
                    R::Worktree,
                    R::Protected
                ]
            ))
        );
    }

    #[test]
    fn merged_is_safe_whether_pushed_or_not() {
        let merged = BranchFacts { merged: true, unmerged: 0, unpushed: 4, ..facts("fertig") };
        assert_eq!(
            classify(&merged, NOW, 90),
            Some((
                BranchCleanupClass::Safe,
                vec![BranchCleanupReason::Merged, BranchCleanupReason::NoPr, BranchCleanupReason::Unpushed { count: 4 }]
            ))
        );
    }

    #[test]
    fn a_merged_pr_is_safe_only_without_commits_after_its_head() {
        let squash = BranchFacts { unmerged: 2, pr: PrFact::Merged { number: 20, commits_after_head: false }, ..facts("feature/thema-20") };
        assert_eq!(classify(&squash, NOW, 90).unwrap().0, BranchCleanupClass::Safe);
        let later = BranchFacts { pr: PrFact::Merged { number: 30, commits_after_head: true }, ..squash };
        assert_eq!(classify(&later, NOW, 90).unwrap().0, BranchCleanupClass::Review);
    }

    #[test]
    fn stale_and_upstream_gone_need_review() {
        assert_eq!(classify(&BranchFacts { committed_at: NOW - 91 * DAY, ..facts("alt") }, NOW, 90).unwrap().0, BranchCleanupClass::Review);
        assert_eq!(classify(&BranchFacts { committed_at: NOW - 89 * DAY, ..facts("frisch") }, NOW, 90), None, "younger than the threshold");
        assert_eq!(
            classify(&BranchFacts { committed_at: NOW - 89 * DAY, ..facts("frisch") }, NOW, 30).unwrap().0,
            BranchCleanupClass::Review,
            "own threshold"
        );
        assert_eq!(classify(&BranchFacts { upstream_gone: true, ..facts("verwaist") }, NOW, 90).unwrap().0, BranchCleanupClass::Review);
    }

    #[test]
    fn branches_without_a_cleanup_reason_are_not_listed() {
        assert_eq!(
            classify(&BranchFacts { unpushed: 1, ..facts("aktiv") }, NOW, 90),
            None,
            "noPr, unmerged and unpushed alone are no reason"
        );
        assert_eq!(classify(&BranchFacts { protected: true, ..facts("develop") }, NOW, 90), None, "blocked alone is not listed");
        assert_eq!(
            classify(&BranchFacts { worktree: true, merged: true, unmerged: 0, ..facts("in-arbeit") }, NOW, 90).unwrap().0,
            BranchCleanupClass::Blocked
        );
    }

    #[test]
    fn whether_a_branch_is_listed_does_not_depend_on_the_unmerged_count() {
        // The list command counts unmerged commits only for listed branches (two passes).
        for f in
            [facts("aktiv"), BranchFacts { upstream_gone: true, ..facts("verwaist") }, BranchFacts { protected: true, ..facts("develop") }]
        {
            assert_eq!(
                classify(&BranchFacts { unmerged: 0, ..f.clone() }, NOW, 90).is_some(),
                classify(&BranchFacts { unmerged: 7, ..f }, NOW, 90).is_some()
            );
        }
    }

    #[test]
    fn without_pr_data_there_is_neither_pr_merged_nor_no_pr() {
        let unknown = BranchFacts { merged: true, unmerged: 0, pr: PrFact::Unknown, ..facts("fertig") };
        assert_eq!(classify(&unknown, NOW, 90).unwrap().1, vec![BranchCleanupReason::Merged]);
        let open = BranchFacts { upstream_gone: true, pr: PrFact::Open, ..facts("offen") };
        assert!(!classify(&open, NOW, 90).unwrap().1.contains(&BranchCleanupReason::NoPr));
    }

    #[test]
    fn protected_patterns_match_whole_names_and_star_crosses_slashes() {
        for name in ["main", "master", "develop", "release/2026.1", "hotfix/ärger"] {
            assert!(is_protected(name, &[]), "{name}");
        }
        for name in ["mainline", "feature/release/x", "my-develop"] {
            assert!(!is_protected(name, &[]), "{name}");
        }
        let own = vec!["team/*".to_string(), "v1.?".to_string()];
        assert!(is_protected("team/a/b", &own));
        assert!(is_protected("v1.?", &own) && !is_protected("v1.2", &own), "only * is a wildcard");
        assert!(is_protected("Release/1.0", &[]) && is_protected("MAIN", &[]), "ASCII case-insensitive");
        assert!(is_protected("release/1.0", &["Release/*".to_string()]));
    }

    #[test]
    fn glob_edge_cases() {
        assert!(glob_matches("a*b*c", "abc") && glob_matches("a*b*c", "a-b-b-c") && glob_matches("a*b*c", "a/x/b/y/c"));
        assert!(!glob_matches("a*b*c", "acb") && !glob_matches("a*b*c", "abcd"));
        assert!(!glob_matches("a*a", "a"), "prefix and suffix must not overlap");
        assert!(glob_matches("a*a", "aa") && glob_matches("a*a", "aba"));
        assert!(glob_matches("*", "") && glob_matches("*", "x/y"));
        assert!(glob_matches("", "") && !glob_matches("", "x"), "empty pattern matches only the empty name");
        assert!(glob_matches("Team/*", "team/Übung") && !glob_matches("team/ü*", "team/Übung"), "case folding is ASCII only");
    }
}
