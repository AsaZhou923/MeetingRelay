use core::{fmt, str::FromStr};

/// An unsigned 64-bit value with the canonical decimal representation required
/// at MeetingRelay JSON and IPC boundaries.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct CanonicalU64(u64);

impl CanonicalU64 {
    #[must_use]
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }
}

impl fmt::Display for CanonicalU64 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl From<u64> for CanonicalU64 {
    fn from(value: u64) -> Self {
        Self::new(value)
    }
}

impl From<CanonicalU64> for u64 {
    fn from(value: CanonicalU64) -> Self {
        value.get()
    }
}

impl FromStr for CanonicalU64 {
    type Err = ParseCanonicalU64Error;

    fn from_str(input: &str) -> Result<Self, Self::Err> {
        let bytes = input.as_bytes();
        if bytes.is_empty() {
            return Err(ParseCanonicalU64Error::Empty);
        }
        if bytes.len() > 1 && bytes[0] == b'0' {
            return Err(ParseCanonicalU64Error::LeadingZero);
        }

        let mut value = 0_u64;
        for (index, byte) in bytes.iter().copied().enumerate() {
            if !byte.is_ascii_digit() {
                return Err(ParseCanonicalU64Error::InvalidDigit { index });
            }
            value = value
                .checked_mul(10)
                .and_then(|current| current.checked_add(u64::from(byte - b'0')))
                .ok_or(ParseCanonicalU64Error::Overflow)?;
        }

        Ok(Self(value))
    }
}

impl TryFrom<&str> for CanonicalU64 {
    type Error = ParseCanonicalU64Error;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        value.parse()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ParseCanonicalU64Error {
    Empty,
    LeadingZero,
    InvalidDigit { index: usize },
    Overflow,
}

impl fmt::Display for ParseCanonicalU64Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("unsigned decimal string is empty"),
            Self::LeadingZero => formatter.write_str("unsigned decimal string has a leading zero"),
            Self::InvalidDigit { index } => {
                write!(
                    formatter,
                    "unsigned decimal string has an invalid byte at {index}"
                )
            }
            Self::Overflow => formatter.write_str("unsigned decimal string exceeds u64"),
        }
    }
}

impl std::error::Error for ParseCanonicalU64Error {}

#[cfg(test)]
mod tests {
    use super::{CanonicalU64, ParseCanonicalU64Error};

    #[test]
    fn canonical_u64_accepts_and_formats_the_full_domain() {
        let cases = [
            ("0", 0_u64),
            ("1", 1_u64),
            ("18446744073709551615", u64::MAX),
        ];

        for (encoded, expected) in cases {
            let parsed = encoded.parse::<CanonicalU64>().expect("valid decimal");
            assert_eq!(parsed.get(), expected);
            assert_eq!(parsed.to_string(), encoded);
        }
    }

    #[test]
    fn canonical_u64_rejects_ambiguous_or_out_of_range_text() {
        let cases = [
            ("", ParseCanonicalU64Error::Empty),
            ("00", ParseCanonicalU64Error::LeadingZero),
            ("01", ParseCanonicalU64Error::LeadingZero),
            ("+1", ParseCanonicalU64Error::InvalidDigit { index: 0 }),
            ("-1", ParseCanonicalU64Error::InvalidDigit { index: 0 }),
            ("1 ", ParseCanonicalU64Error::InvalidDigit { index: 1 }),
            ("١", ParseCanonicalU64Error::InvalidDigit { index: 0 }),
            ("18446744073709551616", ParseCanonicalU64Error::Overflow),
        ];

        for (encoded, expected) in cases {
            assert_eq!(encoded.parse::<CanonicalU64>(), Err(expected));
        }
    }
}
