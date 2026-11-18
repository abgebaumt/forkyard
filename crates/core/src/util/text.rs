//! Decoding bytes to text (and file content back to bytes), splitting Git output.

use crate::error::{CoreError, CoreResult};

/// Decode bytes for display; invalid UTF-8 is replaced.
pub fn decode_lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Decode text for display and guess the encoding:
/// UTF-8 (also with BOM), UTF-16 with BOM, otherwise windows-1252.
/// Returns the text and the name of the encoding ("utf-8", "windows-1252", …).
pub fn decode_text(bytes: &[u8]) -> (String, &'static str) {
    if let Some((enc, bom_len)) = encoding_rs::Encoding::for_bom(bytes) {
        let (text, _) = enc.decode_without_bom_handling(&bytes[bom_len..]);
        let name = if enc == encoding_rs::UTF_8 {
            "utf-8"
        } else if enc == encoding_rs::UTF_16LE {
            "utf-16le"
        } else {
            "utf-16be"
        };
        return (text.into_owned(), name);
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_string(), "utf-8"),
        Err(_) => {
            let (text, _, _) = encoding_rs::WINDOWS_1252.decode(bytes);
            (text.into_owned(), "windows-1252")
        }
    }
}

/// Heuristic for binary files as in Git: a NUL byte in the first 8000 bytes.
pub fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|&b| b == 0)
}

/// Shortens a text to at most `max` bytes (at a character boundary) and marks the cut.
pub fn truncate_str(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… (truncated)", &text[..end])
}

/// Splits `-z` output at NUL bytes; a trailing NUL does not produce an empty entry.
pub fn split_z(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    split_records(bytes, 0)
}

/// Splits bytes at a separator byte; an empty remainder at the end is left out.
pub fn split_records(bytes: &[u8], sep: u8) -> impl Iterator<Item = &[u8]> {
    let trimmed = if bytes.last() == Some(&sep) { &bytes[..bytes.len() - 1] } else { bytes };
    let empty = trimmed.is_empty();
    trimmed.split(move |&b| b == sep).filter(move |_| !empty)
}

/// Encoding name for UTF-8 with a byte order mark (`FileContent.encoding`, `file_write`).
pub const UTF8_BOM: &str = "utf-8-bom";

fn encoding_name(enc: &'static encoding_rs::Encoding) -> String {
    enc.name().to_ascii_lowercase()
}

/// The preferred encoding, if it is known and not UTF-8/UTF-16 anyway.
fn legacy_encoding(preferred: &str) -> Option<&'static encoding_rs::Encoding> {
    encoding_rs::Encoding::for_label(preferred.trim().as_bytes())
        .filter(|e| *e != encoding_rs::UTF_8 && *e != encoding_rs::UTF_16LE && *e != encoding_rs::UTF_16BE)
}

/// Whether the bytes start with a UTF-16 BOM (such files contain NUL bytes but are text).
fn has_utf16_bom(bytes: &[u8]) -> bool {
    matches!(encoding_rs::Encoding::for_bom(bytes), Some((enc, _)) if enc != encoding_rs::UTF_8)
}

/// Binary as with Git (NUL in the first 8000 bytes), except for UTF-16 with a BOM.
pub fn is_binary_content(bytes: &[u8]) -> bool {
    !has_utf16_bom(bytes) && looks_binary(bytes)
}

/// Decodes file content for display and names the encoding with which
/// `encode_content` produces the same bytes again:
/// BOM → "utf-8-bom" / "utf-16le" / "utf-16be"; pure ASCII → the preferred encoding;
/// valid UTF-8 → "utf-8"; otherwise the preferred encoding, falling back to windows-1252.
pub fn decode_content(bytes: &[u8], preferred: &str) -> (String, String) {
    if let Some((enc, bom_len)) = encoding_rs::Encoding::for_bom(bytes) {
        let (text, _) = enc.decode_without_bom_handling(&bytes[bom_len..]);
        let name = if enc == encoding_rs::UTF_8 { UTF8_BOM.to_string() } else { encoding_name(enc) };
        return (text.into_owned(), name);
    }
    let legacy = legacy_encoding(preferred);
    match std::str::from_utf8(bytes) {
        Ok(text) if bytes.is_ascii() => (text.to_string(), legacy.map(encoding_name).unwrap_or_else(|| "utf-8".into())),
        Ok(text) => (text.to_string(), "utf-8".into()),
        Err(_) => {
            let enc = legacy.unwrap_or(encoding_rs::WINDOWS_1252);
            let (text, _) = enc.decode_without_bom_handling(bytes);
            (text.into_owned(), encoding_name(enc))
        }
    }
}

/// Converts text into the named encoding. Unknown name → `not_allowed`;
/// characters the encoding does not know → `unsupported` (nothing is silently replaced).
pub fn encode_content(text: &str, encoding: &str) -> CoreResult<Vec<u8>> {
    let label = encoding.trim().to_lowercase();
    if label.is_empty() || label == "utf-8" || label == "utf8" {
        return Ok(text.as_bytes().to_vec());
    }
    if label == UTF8_BOM || label == "utf8-bom" {
        let mut out = vec![0xEF, 0xBB, 0xBF];
        out.extend_from_slice(text.as_bytes());
        return Ok(out);
    }
    let Some(enc) = encoding_rs::Encoding::for_label(label.as_bytes()) else {
        return Err(CoreError::not_allowed(format!("Unknown encoding “{encoding}”.")));
    };
    if enc == encoding_rs::UTF_8 {
        return Ok(text.as_bytes().to_vec());
    }
    if enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE {
        let little = enc == encoding_rs::UTF_16LE;
        let mut out: Vec<u8> = if little { vec![0xFF, 0xFE] } else { vec![0xFE, 0xFF] };
        for unit in text.encode_utf16() {
            out.extend_from_slice(&if little { unit.to_le_bytes() } else { unit.to_be_bytes() });
        }
        return Ok(out);
    }
    if enc.output_encoding() != enc {
        return Err(CoreError::unsupported(format!("Files cannot be saved in the encoding “{encoding}”.")));
    }
    let (bytes, _, unmappable) = enc.encode(text);
    if unmappable {
        return Err(CoreError::unsupported(format!(
            "The text contains characters that don’t exist in the encoding “{}”. Please save it as UTF-8.",
            encoding_name(enc)
        )));
    }
    Ok(bytes.into_owned())
}

/// Encoding given by a single call (`encoding` for `file_read`, `file_blame`,
/// `diff_file`): `None` = detect as before; otherwise read exactly like that, even if the
/// bytes look like something else ("Reopen with encoding"). Unknown name → `not_allowed`.
pub(crate) fn forced_encoding(label: Option<&str>) -> CoreResult<Option<&'static encoding_rs::Encoding>> {
    let Some(label) = label.map(|l| l.trim().to_lowercase()).filter(|l| !l.is_empty()) else { return Ok(None) };
    if label == UTF8_BOM || label == "utf8-bom" {
        return Ok(Some(encoding_rs::UTF_8));
    }
    encoding_rs::Encoding::for_label(label.as_bytes())
        .map(Some)
        .ok_or_else(|| CoreError::not_allowed(format!("Unknown encoding “{label}”.")))
}

/// Decodes with exactly this encoding (a matching BOM at the start is dropped; whatever does not
/// fit is replaced) and names it so that `encode_content` produces the same bytes again.
pub(crate) fn decode_forced(bytes: &[u8], enc: &'static encoding_rs::Encoding) -> (String, String) {
    let (body, had_bom) = match encoding_rs::Encoding::for_bom(bytes) {
        Some((found, len)) if found == enc => (&bytes[len..], true),
        _ => (bytes, false),
    };
    let name = if enc == encoding_rs::UTF_8 && had_bom { UTF8_BOM.to_string() } else { encoding_name(enc) };
    (enc.decode_without_bom_handling(body).0.into_owned(), name)
}

/// Decodes a single line (blame): UTF-8, otherwise the preferred encoding or windows-1252.
pub(crate) fn decode_line(bytes: &[u8], preferred: &str) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => {
            let enc = legacy_encoding(preferred).unwrap_or(encoding_rs::WINDOWS_1252);
            enc.decode_without_bom_handling(bytes).0.into_owned()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    #[test]
    fn encoding_helpers() {
        assert!(is_binary_content(b"a\0b") && !is_binary_content(b"\xff\xfea\0") && !is_binary_content(b""));
        assert_eq!(decode_content(b"", "utf-8"), (String::new(), "utf-8".to_string()));
        assert_eq!(decode_content(b"\x83n", "shift_jis").1, "shift_jis");
        // Unknown preferred encoding: as if none were given.
        assert_eq!(decode_content(b"\xe4", "gibt-es-nicht"), ("ä".to_string(), "windows-1252".to_string()));
        assert_eq!(encode_content("ä", "UTF8").unwrap(), "ä".as_bytes());
        assert_eq!(encode_content("x", "replacement").unwrap_err().code, ErrorCode::Unsupported);
    }

    #[test]
    fn split_z_works() {
        let v: Vec<&[u8]> = split_z(b"a\0b\0").collect();
        assert_eq!(v, vec![b"a".as_slice(), b"b".as_slice()]);
        assert_eq!(split_z(b"").count(), 0);
        assert_eq!(split_z(b"\0").count(), 0);
        let v: Vec<&[u8]> = split_z(b"a\0\0b").collect();
        assert_eq!(v.len(), 3);
    }

    #[test]
    fn decode_guesses() {
        assert_eq!(decode_text("Grüße".as_bytes()), ("Grüße".to_string(), "utf-8"));
        assert_eq!(decode_text(b"Gr\xfc\xdfe"), ("Grüße".to_string(), "windows-1252"));
        assert_eq!(decode_text(b"\xef\xbb\xbfhi").1, "utf-8");
        assert!(looks_binary(b"ab\0c"));
    }

    /// The two guessers agree on the text; they differ only where callers need it: `decode_text`
    /// (merge, diff, display) names UTF-8 with a BOM "utf-8" (callers track the BOM separately),
    /// `decode_content` (file editor) names it "utf-8-bom" and honours the preferred encoding.
    #[test]
    fn decode_text_and_decode_content_rules() {
        let cases: [&[u8]; 8] = [
            b"",
            b"plain",
            "Gr\u{fc}\u{df}e".as_bytes(),
            b"Gr\xfc\xdfe",
            b"\xef\xbb\xbfhi",
            b"\xff\xfeh\0",
            b"\xfe\xff\0h",
            b"\x81\x8d\x8f",
        ];
        for bytes in cases {
            let (text, name) = decode_text(bytes);
            let (content, content_name) = decode_content(bytes, "utf-8");
            assert_eq!(text, content, "{bytes:?}");
            let expected = if content_name == UTF8_BOM { "utf-8" } else { content_name.as_str() };
            assert_eq!(name, expected, "{bytes:?}");
        }
        assert_eq!(decode_text(b"\xef\xbb\xbfhi"), ("hi".to_string(), "utf-8"));
        assert_eq!(decode_content(b"\xef\xbb\xbfhi", "utf-8"), ("hi".to_string(), UTF8_BOM.to_string()));
        assert_eq!(decode_text(b"\xff\xfeh\0"), ("h".to_string(), "utf-16le"));
        assert_eq!(decode_text(b"\xfe\xff\0h"), ("h".to_string(), "utf-16be"));
        // Only `decode_content` takes the repository's preferred encoding into account.
        assert_eq!(decode_text(b"\xe4").1, "windows-1252");
        assert_eq!(decode_content(b"\xe4", "iso-8859-2").1, "iso-8859-2");
    }

    #[test]
    fn truncation() {
        assert_eq!(truncate_str("abc", 10), "abc");
        assert!(truncate_str("äöü", 3).starts_with('ä'));
    }
}
