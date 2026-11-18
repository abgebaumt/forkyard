//! Time stamps as ISO-8601 text.

/// Now in UTC as ISO-8601 with milliseconds and `Z`.
pub fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// Point in time `days` days ago, in the same format as `now_iso`.
pub fn iso_days_ago(days: i64) -> String {
    (chrono::Utc::now() - chrono::Duration::days(days)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// Unix seconds (as from `git log --format=%at`) to ISO-8601 UTC.
///
/// Years outside 0000–9999 (a commit with a nonsensical date) are written in the extended
/// notation with sign and six digits (`+010000-01-01T…`): only that is understood by
/// `new Date()` in the UI – "+10000-…", as chrono writes it, is invalid there.
pub fn unix_to_iso(secs: i64) -> String {
    use chrono::Datelike;
    let time = chrono::DateTime::from_timestamp(secs, 0).unwrap_or_default();
    let year = time.year();
    if (0..=9999).contains(&year) {
        return time.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    }
    let sign = if year < 0 { '-' } else { '+' };
    format!("{sign}{:06}-{}", year.unsigned_abs(), time.format("%m-%dT%H:%M:%S%.3fZ"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Years beyond 9999 in the notation that `new Date()` understands.
    #[test]
    fn unix_to_iso_writes_years_beyond_9999_in_the_expanded_form() {
        assert_eq!(unix_to_iso(1_772_434_800), "2026-03-02T07:00:00.000Z");
        assert_eq!(unix_to_iso(253_402_300_799), "9999-12-31T23:59:59.000Z");
        assert_eq!(unix_to_iso(253_402_300_800), "+010000-01-01T00:00:00.000Z");
        assert_eq!(unix_to_iso(-62_167_219_201), "-000001-12-31T23:59:59.000Z");
        // Absurdly large values: the start of the epoch, as before.
        assert_eq!(unix_to_iso(i64::MAX), "1970-01-01T00:00:00.000Z");
    }
}
