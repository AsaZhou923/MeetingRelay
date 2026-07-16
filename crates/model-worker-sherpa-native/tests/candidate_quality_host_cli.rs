#![cfg(all(feature = "native-quality-sample", debug_assertions))]

use std::process::Command;

const HOST: &str = env!("CARGO_BIN_EXE_meetingrelay-sherpa-candidate-quality-host");

#[test]
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
