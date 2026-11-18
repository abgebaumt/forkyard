//! Decoding bytes to text and splitting Git output.

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

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn truncation() {
        assert_eq!(truncate_str("abc", 10), "abc");
        assert!(truncate_str("äöü", 3).starts_with('ä'));
    }
}
