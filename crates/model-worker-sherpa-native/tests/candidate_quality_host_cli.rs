#![cfg(feature = "native-quality-sample")]

use std::process::Command;

const HOST: &str = env!("CARGO_BIN_EXE_meetingrelay-sherpa-candidate-quality-host");

#[test]
#[cfg(debug_assertions)]
fn debug_quality_host_refuses_evidence_emission() {
    let output = Command::new(HOST)
        .args([
            "schema",
            "model",
            "tokens",
            "runtime",
            "asset-lock",
            "package-lock",
            "sample-001",
            "zh",
            "sample.wav",
            "44",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        ])
        .output()
        .expect("run debug quality host");

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(output.stderr, b"SHERPA_QUALITY_RELEASE_REQUIRED\n");
}

#[test]
fn quality_host_errors_never_echo_untrusted_text_to_stderr() {
    let sentinel = "private-transcript-sentinel";
    let output = Command::new(HOST)
        .args([
            sentinel,
            "model",
            "tokens",
            "runtime",
            "asset-lock",
            "package-lock",
            "sample-001",
            "zh",
            "sample.wav",
            "44",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        ])
        .output()
        .expect("run quality host with private sentinel");

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    if cfg!(debug_assertions) {
        assert_eq!(output.stderr, b"SHERPA_QUALITY_RELEASE_REQUIRED\n");
    } else {
        assert_eq!(output.stderr, b"SHERPA_QUALITY_INVALID_INPUT\n");
    }
    assert!(!String::from_utf8_lossy(&output.stderr).contains(sentinel));
}

#[test]
fn quality_host_requires_exactly_thirteen_nonempty_arguments() {
    for arguments in [
        Vec::<&str>::new(),
        vec!["one"],
        vec!["one"; 12],
        vec!["one"; 14],
        vec![""; 13],
    ] {
        let output = Command::new(HOST)
            .args(arguments)
            .output()
            .expect("run quality host with invalid arguments");
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert_eq!(output.stderr, b"SHERPA_QUALITY_USAGE\n");
    }
}
