//! Canonical text forms for decimal and temporal values.
use chrono::{NaiveDate, NaiveDateTime, NaiveTime, Timelike};

/// Validates a decimal literal and returns it in plain notation with exactly
/// `scale` fractional digits when a precision is declared.
pub fn canonical_decimal(raw: &str, precision: Option<u8>, scale: u8) -> Result<String, String> {
    let t = raw.trim();
    let (negative, body) = match t.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let (mantissa, exponent) = match body.find(['e', 'E']) {
        Some(i) => (
            &body[..i],
            body[i + 1..]
                .parse::<i32>()
                .map_err(|_| format!("{raw:?} is not a decimal number"))?,
        ),
        None => (body, 0),
    };
    let (int_part, frac_part) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    if (int_part.is_empty() && frac_part.is_empty())
        || !int_part.chars().all(|c| c.is_ascii_digit())
        || !frac_part.chars().all(|c| c.is_ascii_digit())
    {
        return Err(format!("{raw:?} is not a decimal number"));
    }
    let mut digits: String = format!("{int_part}{frac_part}");
    let mut point = int_part.len() as i32 + exponent;
    if point < 0 {
        digits = format!("{}{digits}", "0".repeat((-point) as usize));
        point = 0;
    }
    while (digits.len() as i32) < point {
        digits.push('0');
    }
    let (int_digits, frac_digits) = digits.split_at(point as usize);
    let int_digits = int_digits.trim_start_matches('0');
    let mut frac = frac_digits.trim_end_matches('0').to_string();
    if let Some(p) = precision {
        if frac.len() > scale as usize {
            return Err(format!(
                "{raw} has more than {scale} decimal place{}",
                if scale == 1 { "" } else { "s" }
            ));
        }
        if int_digits.len() > (p - scale) as usize {
            return Err(format!("{raw} does not fit decimal({p},{scale})"));
        }
        while frac.len() < scale as usize {
            frac.push('0');
        }
    }
    let int_text = if int_digits.is_empty() {
        "0"
    } else {
        int_digits
    };
    let zero = int_text == "0" && frac.chars().all(|c| c == '0');
    let sign = if negative && !zero { "-" } else { "" };
    Ok(if frac.is_empty() {
        format!("{sign}{int_text}")
    } else {
        format!("{sign}{int_text}.{frac}")
    })
}

pub fn parse_date(t: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(t.trim(), "%Y-%m-%d").ok()
}
pub fn parse_time(t: &str) -> Option<NaiveTime> {
    let t = t.trim();
    NaiveTime::parse_from_str(t, "%H:%M:%S%.f")
        .or_else(|_| NaiveTime::parse_from_str(t, "%H:%M"))
        .ok()
}
/// Accepts `YYYY-MM-DD[ T]HH:MM[:SS[.f]]`, RFC 3339 with an offset (converted
/// to UTC), or a bare date (midnight).
pub fn parse_timestamp(t: &str) -> Option<NaiveDateTime> {
    let t = t.trim();
    if let Ok(v) = chrono::DateTime::parse_from_rfc3339(t) {
        return Some(v.naive_utc());
    }
    let t = t.strip_suffix('Z').unwrap_or(t);
    for f in [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M",
    ] {
        if let Ok(v) = NaiveDateTime::parse_from_str(t, f) {
            return Some(v);
        }
    }
    parse_date(t).and_then(|d| d.and_hms_opt(0, 0, 0))
}
fn fraction(nanos: u32) -> String {
    if nanos == 0 {
        return String::new();
    }
    let micros = format!("{:06}", nanos / 1000);
    let trimmed = micros.trim_end_matches('0');
    if trimmed.is_empty() {
        String::new()
    } else {
        format!(".{trimmed}")
    }
}
pub fn format_time(v: NaiveTime) -> String {
    format!("{}{}", v.format("%H:%M:%S"), fraction(v.nanosecond()))
}
pub fn format_timestamp(v: NaiveDateTime) -> String {
    format!(
        "{}{}",
        v.format("%Y-%m-%dT%H:%M:%S"),
        fraction(v.and_utc().timestamp_subsec_nanos())
    )
}
