use meetingrelay_model_worker_contract::{
    SIDECAR_WIRE_MAGIC, SIDECAR_WIRE_MAX_HEADER_LEN, SIDECAR_WIRE_PRELUDE_LEN,
    SIDECAR_WIRE_VERSION, SidecarWireDirection, SidecarWireError,
    build_sidecar_wire_transcript_preimage, decode_sidecar_wire_frame, encode_sidecar_wire_frame,
};

const HEADER: &str = "{\"kind\":\"hello\",\"sequence\":1}\n";
const PAYLOAD: &[u8] = b"payload bytes";

#[test]
fn clean_roundtrip_preserves_header_payload_and_big_endian_lengths() {
    let encoded = encode_sidecar_wire_frame(HEADER, PAYLOAD, PAYLOAD.len()).expect("encode");

    assert_eq!(&encoded[..4], &SIDECAR_WIRE_MAGIC);
    assert_eq!(encoded[4], SIDECAR_WIRE_VERSION);
    assert_eq!(
        u32::from_be_bytes(encoded[5..9].try_into().expect("header len")),
        u32::try_from(HEADER.len()).expect("header len fits")
    );
    assert_eq!(
        u32::from_be_bytes(encoded[9..13].try_into().expect("payload len")),
        u32::try_from(PAYLOAD.len()).expect("payload len fits")
    );

    let decoded = decode_sidecar_wire_frame(&encoded, PAYLOAD.len()).expect("decode");
    assert_eq!(decoded.header_json_line(), HEADER);
    assert_eq!(decoded.payload(), PAYLOAD);
    assert_eq!(
        encoded.len(),
        SIDECAR_WIRE_PRELUDE_LEN + HEADER.len() + PAYLOAD.len()
    );
}

#[test]
fn rejects_wrong_magic_and_version() {
    let mut encoded = encode_sidecar_wire_frame(HEADER, PAYLOAD, PAYLOAD.len()).expect("encode");

    encoded[0] = b'X';
    assert_eq!(
        decode_sidecar_wire_frame(&encoded, PAYLOAD.len()).expect_err("wrong magic"),
        SidecarWireError::WrongMagic
    );
    assert_eq!(
        SidecarWireError::WrongMagic.stable_code(),
        "SIDECAR_WIRE_WRONG_MAGIC"
    );

    let mut encoded = encode_sidecar_wire_frame(HEADER, PAYLOAD, PAYLOAD.len()).expect("encode");
    encoded[4] = SIDECAR_WIRE_VERSION + 1;
    assert_eq!(
        decode_sidecar_wire_frame(&encoded, PAYLOAD.len()).expect_err("wrong version"),
        SidecarWireError::UnsupportedVersion
    );
}

#[test]
fn rejects_length_mismatch_and_trailing_bytes() {
    let mut encoded = encode_sidecar_wire_frame(HEADER, PAYLOAD, PAYLOAD.len()).expect("encode");
    encoded[8] = encoded[8].wrapping_add(1);
    assert_eq!(
        decode_sidecar_wire_frame(&encoded, PAYLOAD.len()).expect_err("bad header length"),
        SidecarWireError::LengthMismatch
    );

    let mut encoded = encode_sidecar_wire_frame(HEADER, PAYLOAD, PAYLOAD.len()).expect("encode");
    encoded.push(b'!');
    assert_eq!(
        decode_sidecar_wire_frame(&encoded, PAYLOAD.len()).expect_err("trailing byte"),
        SidecarWireError::LengthMismatch
    );

    assert_eq!(
        decode_sidecar_wire_frame(&encoded[..SIDECAR_WIRE_PRELUDE_LEN - 1], PAYLOAD.len())
            .expect_err("short frame"),
        SidecarWireError::FrameTooShort
    );
}

#[test]
fn rejects_utf8_bom_cr_nul_and_line_ending_violations() {
    assert_eq!(
        encode_sidecar_wire_frame("\u{feff}{\"kind\":\"hello\"}\n", &[], 0)
            .expect_err("bom rejected"),
        SidecarWireError::HeaderBom
    );
    assert_eq!(
        encode_sidecar_wire_frame("{\"kind\":\"hello\"}\r\n", &[], 0).expect_err("cr rejected"),
        SidecarWireError::HeaderCarriageReturn
    );
    assert_eq!(
        encode_sidecar_wire_frame("{\"kind\":\"hello\0\"}\n", &[], 0).expect_err("nul rejected"),
        SidecarWireError::HeaderNul
    );
    assert_eq!(
        encode_sidecar_wire_frame("{\"kind\":\"hello\"}", &[], 0).expect_err("missing lf"),
        SidecarWireError::HeaderLineEnding
    );
    assert_eq!(
        encode_sidecar_wire_frame("{\"kind\":\"hello\"}\n\n", &[], 0).expect_err("extra lf"),
        SidecarWireError::HeaderLineEnding
    );
}

#[test]
fn rejects_non_utf8_header_on_decode() {
    let mut encoded = Vec::new();
    encoded.extend_from_slice(&SIDECAR_WIRE_MAGIC);
    encoded.push(SIDECAR_WIRE_VERSION);
    encoded.extend_from_slice(&2_u32.to_be_bytes());
    encoded.extend_from_slice(&0_u32.to_be_bytes());
    encoded.extend_from_slice(&[0xFF, b'\n']);

    assert_eq!(
        decode_sidecar_wire_frame(&encoded, 0).expect_err("non utf8"),
        SidecarWireError::HeaderUtf8
    );
}

#[test]
fn enforces_header_and_payload_boundaries() {
    assert_eq!(
        encode_sidecar_wire_frame("", &[], 0).expect_err("empty header"),
        SidecarWireError::HeaderEmpty
    );

    let oversized_header = format!("{}{}\n", "a".repeat(SIDECAR_WIRE_MAX_HEADER_LEN), "b");
    assert_eq!(
        encode_sidecar_wire_frame(&oversized_header, &[], 0).expect_err("oversized header"),
        SidecarWireError::HeaderTooLarge
    );

    let max_header = format!("{}\n", "a".repeat(SIDECAR_WIRE_MAX_HEADER_LEN - 1));
    encode_sidecar_wire_frame(&max_header, &[], 0).expect("max header accepted");

    assert_eq!(
        encode_sidecar_wire_frame(HEADER, PAYLOAD, PAYLOAD.len() - 1)
            .expect_err("oversized payload"),
        SidecarWireError::PayloadTooLarge
    );

    let mut encoded = encode_sidecar_wire_frame(HEADER, PAYLOAD, PAYLOAD.len()).expect("encode");
    encoded[9..13].copy_from_slice(
        &u32::try_from(PAYLOAD.len() + 1)
            .expect("payload len fits")
            .to_be_bytes(),
    );
    assert_eq!(
        decode_sidecar_wire_frame(&encoded, PAYLOAD.len()).expect_err("declared payload too big"),
        SidecarWireError::PayloadTooLarge
    );
}

#[test]
fn direction_transcript_preimage_is_domain_separated_and_frame_exact() {
    let first = encode_sidecar_wire_frame(HEADER, PAYLOAD, PAYLOAD.len()).expect("encode first");
    let second_header = "{\"kind\":\"result\",\"sequence\":2}\n";
    let second_payload = b"second payload";
    let second = encode_sidecar_wire_frame(second_header, second_payload, second_payload.len())
        .expect("encode second");

    let preimage = build_sidecar_wire_transcript_preimage([
        (SidecarWireDirection::CoreToWorker, first.as_slice()),
        (SidecarWireDirection::WorkerToCore, second.as_slice()),
    ])
    .expect("session transcript preimage");
    let reversed = build_sidecar_wire_transcript_preimage([
        (SidecarWireDirection::WorkerToCore, first.as_slice()),
        (SidecarWireDirection::CoreToWorker, second.as_slice()),
    ])
    .expect("reversed directions");

    let mut expected = Vec::new();
    expected.extend_from_slice(b"meetingrelay.sidecar-wire.transcript.v1\n");
    expected.push(b'H');
    expected.extend_from_slice(&first);
    expected.push(b'W');
    expected.extend_from_slice(&second);

    assert_eq!(preimage, expected);
    assert_ne!(preimage, reversed);
    assert_eq!(
        preimage
            .windows(b"meetingrelay.sidecar-wire.transcript.v1\n".len())
            .filter(|window| *window == b"meetingrelay.sidecar-wire.transcript.v1\n")
            .count(),
        1
    );
}
