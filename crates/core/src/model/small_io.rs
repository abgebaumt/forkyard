//! Small inputs and outputs of individual commands

use super::*;

/// `kind` of `refNameCheck`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefNameKind {
    Branch,
    Tag,
}

/// Result of `refNameCheck`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefNameCheck {
    pub valid: bool,
    pub reason: Option<String>,
}
