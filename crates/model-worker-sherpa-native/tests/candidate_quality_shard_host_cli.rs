#![cfg(feature = "native-quality-shard")]

use std::process::{Command, Stdio};

const HOST: &str = env!("CARGO_BIN_EXE_meetingrelay-sherpa-candidate-quality-shard-host");

#[test]
#[cfg(debug_assertions)]
fn debug_quality_shard_host_refuses_evidence_emission() {
    let output = Command::new(HOST)
        .args([
            "schema",
            "model",
            "tokens",
            "runtime",
            "asset-lock",
            "package-lock",
            "zh",
            "40",
            "2684354560",
        ])
        .stdin(Stdio::null())
        .output()
        .expect("run debug shard host");

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(output.stderr, b"SHERPA_QUALITY_SHARD_RELEASE_REQUIRED\n");
}

#[test]
fn quality_shard_host_requires_exactly_nine_nonempty_arguments() {
    for arguments in [
        Vec::<&str>::new(),
        vec!["one"],
        vec!["one"; 8],
        vec!["one"; 10],
        vec![""; 9],
    ] {
        let output = Command::new(HOST)
            .args(arguments)
            .stdin(Stdio::null())
            .output()
            .expect("run shard host with invalid arguments");
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert_eq!(output.stderr, b"SHERPA_QUALITY_SHARD_USAGE\n");
    }
}

#[test]
fn quality_shard_host_errors_never_echo_untrusted_arguments() {
    let sentinel = "private-transcript-sentinel";
    let output = Command::new(HOST)
        .args([
            sentinel,
            "model",
            "tokens",
            "runtime",
            "asset-lock",
            "package-lock",
            "zh",
            "40",
            "2684354560",
        ])
        .stdin(Stdio::null())
        .output()
        .expect("run shard host with private sentinel");

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    if cfg!(debug_assertions) {
        assert_eq!(output.stderr, b"SHERPA_QUALITY_SHARD_RELEASE_REQUIRED\n");
    } else {
        assert_eq!(output.stderr, b"SHERPA_QUALITY_SHARD_INVALID_INPUT\n");
    }
    assert!(!String::from_utf8_lossy(&output.stderr).contains(sentinel));
}
