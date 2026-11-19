//! Credentials

use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "credentials.ts"))]
#[serde(rename_all = "camelCase")]
pub struct SshKey {
    pub id: Id,
    pub label: String,
    pub private_key_path: String,
    pub public_key_path: String,
    pub public_key: String,
    pub fingerprint: Option<String>,
    pub has_passphrase: bool,
    pub is_default: bool,
    pub missing: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "credentials.ts"))]
#[serde(rename_all = "snake_case")]
pub enum HostAccountKind {
    Password,
    Passphrase,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "credentials.ts"))]
#[serde(rename_all = "camelCase")]
pub struct HostAccount {
    pub id: Id,
    pub host: String,
    pub username: String,
    pub kind: HostAccountKind,
    pub created_at: IsoTime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "credentials.ts"))]
#[serde(rename_all = "snake_case")]
pub enum CredentialKind {
    Username,
    Password,
    Passphrase,
    HostKey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "credentials.ts"))]
#[serde(rename_all = "camelCase")]
pub struct CredentialRequest {
    pub request_id: String,
    pub kind: CredentialKind,
    pub host: String,
    pub username: Option<String>,
    pub detail: Option<String>,
    pub prompt: String,
    pub can_remember: bool,
}

/// `credential:closed`: the prompt `request_id` ended without an answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "credentials.ts"))]
#[serde(rename_all = "camelCase")]
pub struct CredentialClosedEvent {
    pub request_id: String,
}
