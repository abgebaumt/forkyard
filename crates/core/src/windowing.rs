//! The window that called the current command. The binding wraps every command in `scoped`,
//! so the core reads its caller without a parameter. Outside a scope (tests, start-up) there is none.
//! Spawned tasks lose the scope: jobs they start belong to no window, and commands act in the last
//! focused one (`commands::window::calling_window`).

use std::future::Future;

/// Label of the first window at start.
pub const MAIN: &str = "main";

tokio::task_local! {
    static CALLER: String;
}

/// Runs `f` with `label` as the calling window.
pub async fn scoped<F: Future>(label: String, f: F) -> F::Output {
    CALLER.scope(label, f).await
}

/// The calling window, `None` outside a scope.
pub fn caller() -> Option<String> {
    CALLER.try_with(Clone::clone).ok()
}

/// A fresh label for a further window: `w-` and 32 lowercase hex characters.
pub fn new_label() -> String {
    format!("w-{}", uuid::Uuid::new_v4().simple())
}

/// `main` or a label from `new_label`; anything else from the UI is rejected.
pub fn is_label(s: &str) -> bool {
    s == MAIN || s.strip_prefix("w-").is_some_and(|hex| hex.len() == 32 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_caller_is_visible_across_awaits() {
        assert_eq!(caller(), None);
        let seen = scoped("w-0123456789abcdef0123456789abcdef".into(), async {
            tokio::task::yield_now().await;
            caller()
        })
        .await;
        assert_eq!(seen.as_deref(), Some("w-0123456789abcdef0123456789abcdef"));
    }

    #[test]
    fn labels() {
        assert!(is_label("main") && is_label(&new_label()));
        for bad in ["", "w-", "w-XYZ", "main2", "w-0123456789abcdef0123456789abcde", "../main"] {
            assert!(!is_label(bad), "{bad}");
        }
    }
}
