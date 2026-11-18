//! Decoding bytes to text (and file content back to bytes), splitting Git output.

use crate::error::{CoreError, CoreResult};

/// Decode bytes for display; invalid UTF-8 is replaced.
pub fn decode_lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Decode text for display and guess the encoding: `decode_content` with UTF-8 preferred, except
/// that UTF-8 with a BOM is named "utf-8" (callers track the BOM themselves).
/// Returns the text and the name of the encoding ("utf-8", "utf-16le", "utf-16be", "windows-1252").
pub fn decode_text(bytes: &[u8]) -> (String, &'static str) {
    let (text, name) = decode_content(bytes, "utf-8");
    let name = match name.as_str() {
        "utf-16le" => "utf-16le",
        "utf-16be" => "utf-16be",
        "windows-1252" => "windows-1252",
        _ => "utf-8",
    };
    (text, name)
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

/// Splits a command line into program and arguments, without a shell.
///
/// - Whitespace separates; `"…"` and `'…'` group (also in the middle of a word).
/// - With `backslash_escapes` (Linux, macOS), `\` outside of quotes protects the
///   next character, and inside `"…"` `\"` and `\\` stand for `"` and `\`.
/// - Without `backslash_escapes` (Windows), `\` is the path separator and stays literal everywhere,
///   also in `"C:\Folder\"`. A quote inside an argument is not possible there
///   (it does not occur in Windows paths).
///
/// Unclosed quotes → `not_allowed`.
pub fn split_command_line(line: &str, backslash_escapes: bool) -> CoreResult<Vec<String>> {
    let mut args: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_word = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') if backslash_escapes && matches!(chars.peek(), Some('"' | '\\')) => {
                            current.extend(chars.next());
                        }
                        Some(other) => current.push(other),
                        None => return Err(unclosed_quote(line)),
                    }
                }
            }
            '\'' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(other) => current.push(other),
                        None => return Err(unclosed_quote(line)),
                    }
                }
            }
            '\\' if backslash_escapes => {
                in_word = true;
                current.push(chars.next().unwrap_or('\\'));
            }
            c if c.is_whitespace() => {
                if in_word {
                    args.push(std::mem::take(&mut current));
                    in_word = false;
                }
            }
            other => {
                in_word = true;
                current.push(other);
            }
        }
    }
    if in_word {
        args.push(current);
    }
    Ok(args)
}

fn unclosed_quote(line: &str) -> CoreError {
    CoreError::not_allowed(format!("A quotation mark in the command “{line}” is not closed."))
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

    fn split(line: &str, escapes: bool) -> Vec<String> {
        split_command_line(line, escapes).unwrap()
    }

    #[test]
    fn splits_command_lines_without_a_shell() {
        assert_eq!(split("code --wait {path}", false), ["code", "--wait", "{path}"]);
        assert_eq!(split("  a   b\tc\n", true), ["a", "b", "c"]);
        assert_eq!(split(r#""C:\Program Files\Editor\ed.exe" -n "{path}""#, false), [r"C:\Program Files\Editor\ed.exe", "-n", "{path}"]);
        // A folder at the end of a quoted argument: the backslash stays literal.
        assert_eq!(split(r#"x "C:\Ordner\" y"#, false), ["x", r"C:\Ordner\", "y"]);
        assert_eq!(split(r#""C:\a b\\c" "\\server\x y""#, false), [r"C:\a b\\c", r"\\server\x y"]);
        assert_eq!(split(r#"x "a \"b\" c\\" 'd\' "e\f""#, true), ["x", r#"a "b" c\"#, r"d\", r"e\f"]);
        assert_eq!(split(r"\\server\freigabe\ed.exe a", false), [r"\\server\freigabe\ed.exe", "a"]);
        assert_eq!(split("'/opt/mein editor/ed' --flag='a b' ''", true), ["/opt/mein editor/ed", "--flag=a b", ""]);
        assert_eq!(split(r"/opt/mein\ editor/ed a\\b", true), ["/opt/mein editor/ed", r"a\b"]);
        assert_eq!(split(r#"pre"mit te"post"#, true), ["premit tepost"]);
        // Shell characters have no meaning.
        assert_eq!(
            split("ed {path}; rm -rf ~ && echo $HOME | x > y `z`", true),
            ["ed", "{path};", "rm", "-rf", "~", "&&", "echo", "$HOME", "|", "x", ">", "y", "`z`"]
        );
        assert!(split("", true).is_empty() && split("   ", false).is_empty());
        for bad in [r#"ed "offen"#, "ed 'offen", r#"ed "a\""#] {
            assert_eq!(split_command_line(bad, true).unwrap_err().code, ErrorCode::NotAllowed, "{bad}");
        }
    }

    #[test]
    fn truncation() {
        assert_eq!(truncate_str("abc", 10), "abc");
        assert!(truncate_str("äöü", 3).starts_with('ä'));
    }
}
