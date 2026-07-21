//! Std-only binary frame foundation for native sidecar transports.
//!
//! This module only defines byte framing. Semantic schema validation,
//! canonical JSON validation beyond line-shape invariants, and Unicode NFC
//! checks remain the responsibility of the upper protocol layer.

use std::fmt;

pub const SIDECAR_WIRE_MAGIC: [u8; 4] = *b"MRSW";
pub const SIDECAR_WIRE_VERSION: u8 = 1;
pub const SIDECAR_WIRE_PRELUDE_LEN: usize = 13;
pub const SIDECAR_WIRE_MAX_HEADER_LEN: usize = 64 * 1024;

const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidecarWireDirection {
    CoreToWorker,
    WorkerToCore,
}

impl SidecarWireDirection {
    pub const fn stable_label(self) -> &'static str {
        match self {
            Self::CoreToWorker => "core-to-worker",
            Self::WorkerToCore => "worker-to-core",
        }
    }

    const fn transcript_marker(self) -> u8 {
        match self {
            Self::CoreToWorker => b'H',
            Self::WorkerToCore => b'W',
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidecarWireFrame {
    header_json_line: String,
    payload: Vec<u8>,
}

impl SidecarWireFrame {
    fn new(header_json_line: String, payload: Vec<u8>) -> Self {
        Self {
            header_json_line,
            payload,
        }
    }

    pub fn header_json_line(&self) -> &str {
        &self.header_json_line
    }

    pub fn payload(&self) -> &[u8] {
        &self.payload
    }

    pub fn into_parts(self) -> (String, Vec<u8>) {
        (self.header_json_line, self.payload)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidecarWireError {
    FrameTooShort,
    WrongMagic,
    UnsupportedVersion,
    HeaderEmpty,
    HeaderTooLarge,
    PayloadTooLarge,
    LengthOverflow,
    LengthMismatch,
    HeaderBom,
    HeaderCarriageReturn,
    HeaderNul,
    HeaderLineEnding,
    HeaderUtf8,
    TranscriptLengthOverflow,
}

impl SidecarWireError {
    pub const fn stable_code(self) -> &'static str {
        match self {
            Self::FrameTooShort => "SIDECAR_WIRE_FRAME_TOO_SHORT",
            Self::WrongMagic => "SIDECAR_WIRE_WRONG_MAGIC",
            Self::UnsupportedVersion => "SIDECAR_WIRE_UNSUPPORTED_VERSION",
            Self::HeaderEmpty => "SIDECAR_WIRE_HEADER_EMPTY",
            Self::HeaderTooLarge => "SIDECAR_WIRE_HEADER_TOO_LARGE",
            Self::PayloadTooLarge => "SIDECAR_WIRE_PAYLOAD_TOO_LARGE",
            Self::LengthOverflow => "SIDECAR_WIRE_LENGTH_OVERFLOW",
            Self::LengthMismatch => "SIDECAR_WIRE_LENGTH_MISMATCH",
            Self::HeaderBom => "SIDECAR_WIRE_HEADER_BOM",
            Self::HeaderCarriageReturn => "SIDECAR_WIRE_HEADER_CARRIAGE_RETURN",
            Self::HeaderNul => "SIDECAR_WIRE_HEADER_NUL",
            Self::HeaderLineEnding => "SIDECAR_WIRE_HEADER_LINE_ENDING",
            Self::HeaderUtf8 => "SIDECAR_WIRE_HEADER_UTF8",
            Self::TranscriptLengthOverflow => "SIDECAR_WIRE_TRANSCRIPT_LENGTH_OVERFLOW",
        }
    }
}

impl fmt::Display for SidecarWireError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.stable_code())
    }
}

impl std::error::Error for SidecarWireError {}

pub fn encode_sidecar_wire_frame(
    header_json_line: &str,
    payload: &[u8],
    max_payload_len: usize,
) -> Result<Vec<u8>, SidecarWireError> {
    let header = validated_header_bytes(header_json_line.as_bytes())?;
    validate_payload_len(payload.len(), max_payload_len)?;

    let header_len = u32::try_from(header.len()).map_err(|_| SidecarWireError::HeaderTooLarge)?;
    let payload_len =
        u32::try_from(payload.len()).map_err(|_| SidecarWireError::PayloadTooLarge)?;
    let total_len = SIDECAR_WIRE_PRELUDE_LEN
        .checked_add(header.len())
        .and_then(|len| len.checked_add(payload.len()))
        .ok_or(SidecarWireError::LengthOverflow)?;

    let mut frame = Vec::with_capacity(total_len);
    frame.extend_from_slice(&SIDECAR_WIRE_MAGIC);
    frame.push(SIDECAR_WIRE_VERSION);
    frame.extend_from_slice(&header_len.to_be_bytes());
    frame.extend_from_slice(&payload_len.to_be_bytes());
    frame.extend_from_slice(header);
    frame.extend_from_slice(payload);
    Ok(frame)
}

pub fn decode_sidecar_wire_frame(
    bytes: &[u8],
    max_payload_len: usize,
) -> Result<SidecarWireFrame, SidecarWireError> {
    if bytes.len() < SIDECAR_WIRE_PRELUDE_LEN {
        return Err(SidecarWireError::FrameTooShort);
    }
    if bytes[..4] != SIDECAR_WIRE_MAGIC {
        return Err(SidecarWireError::WrongMagic);
    }
    if bytes[4] != SIDECAR_WIRE_VERSION {
        return Err(SidecarWireError::UnsupportedVersion);
    }

    let header_len =
        u32::from_be_bytes(bytes[5..9].try_into().expect("header length slice")) as usize;
    let payload_len =
        u32::from_be_bytes(bytes[9..13].try_into().expect("payload length slice")) as usize;

    validate_header_len(header_len)?;
    validate_payload_len(payload_len, max_payload_len)?;

    let payload_start = SIDECAR_WIRE_PRELUDE_LEN
        .checked_add(header_len)
        .ok_or(SidecarWireError::LengthOverflow)?;
    let total_len = payload_start
        .checked_add(payload_len)
        .ok_or(SidecarWireError::LengthOverflow)?;
    if bytes.len() != total_len {
        return Err(SidecarWireError::LengthMismatch);
    }

    let header = validated_header_bytes(&bytes[SIDECAR_WIRE_PRELUDE_LEN..payload_start])?;
    let header_json_line = std::str::from_utf8(header)
        .map_err(|_| SidecarWireError::HeaderUtf8)?
        .to_owned();
    let payload = bytes[payload_start..].to_vec();
    Ok(SidecarWireFrame::new(header_json_line, payload))
}

pub fn build_sidecar_wire_transcript_preimage<'a, I>(frames: I) -> Result<Vec<u8>, SidecarWireError>
where
    I: IntoIterator<Item = (SidecarWireDirection, &'a [u8])>,
{
    let frames: Vec<_> = frames.into_iter().collect();
    let mut total_len = "meetingrelay.sidecar-wire.transcript.v1\n".len();
    for (_, encoded_frame) in &frames {
        total_len = total_len
            .checked_add(1)
            .and_then(|len| len.checked_add(encoded_frame.len()))
            .ok_or(SidecarWireError::TranscriptLengthOverflow)?;
    }

    let mut preimage = Vec::with_capacity(total_len);
    preimage.extend_from_slice(b"meetingrelay.sidecar-wire.transcript.v1\n");
    for (direction, encoded_frame) in frames {
        preimage.push(direction.transcript_marker());
        preimage.extend_from_slice(encoded_frame);
    }
    Ok(preimage)
}

fn validated_header_bytes(header: &[u8]) -> Result<&[u8], SidecarWireError> {
    validate_header_len(header.len())?;
    if header.starts_with(&UTF8_BOM) {
        return Err(SidecarWireError::HeaderBom);
    }
    if header.contains(&b'\r') {
        return Err(SidecarWireError::HeaderCarriageReturn);
    }
    if header.contains(&0) {
        return Err(SidecarWireError::HeaderNul);
    }
    if header.last() != Some(&b'\n') || header[..header.len() - 1].contains(&b'\n') {
        return Err(SidecarWireError::HeaderLineEnding);
    }
    std::str::from_utf8(header).map_err(|_| SidecarWireError::HeaderUtf8)?;
    Ok(header)
}

fn validate_header_len(header_len: usize) -> Result<(), SidecarWireError> {
    if header_len == 0 {
        return Err(SidecarWireError::HeaderEmpty);
    }
    if header_len > SIDECAR_WIRE_MAX_HEADER_LEN {
        return Err(SidecarWireError::HeaderTooLarge);
    }
    Ok(())
}

fn validate_payload_len(
    payload_len: usize,
    max_payload_len: usize,
) -> Result<(), SidecarWireError> {
    if payload_len > max_payload_len || payload_len > u32::MAX as usize {
        return Err(SidecarWireError::PayloadTooLarge);
    }
    Ok(())
}
