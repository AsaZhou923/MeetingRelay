#![cfg(all(
    feature = "native-sherpa",
    feature = "native-fault-fixture",
    debug_assertions
))]

use std::process::Command;

const HOST: &str = env!("CARGO_BIN_EXE_meetingrelay-sherpa-candidate-fault-host");

#[test]
fn debug_fault_host_rejects_fault_execution() {
    let output = Command::new(HOST)
        .args([
            "abort-after-prepare",
            "marker",
            "schema",
            "model",
            "tokens",
            "runtime",
            "lock",
            "cargo",
            "wav",
        ])
        .output()
        .expect("run debug fault host");

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(output.stderr, b"SHERPA_CONFORMANCE_RELEASE_REQUIRED\n");
}

#[test]
fn fault_host_requires_exact_mode_and_nine_nonempty_arguments() {
    let cases = [
        Vec::<&str>::new(),
        vec![
            "abort", "marker", "schema", "model", "tokens", "runtime", "lock", "cargo", "wav",
        ],
        vec![
            "hang-after-inference",
            "marker",
            "schema",
            "model",
            "tokens",
            "runtime",
            "lock",
            "cargo",
        ],
        vec![
            "hang-after-inference",
            "marker",
            "schema",
            "model",
            "tokens",
            "runtime",
            "lock",
            "cargo",
            "wav",
            "extra",
        ],
        vec![
            "hang-after-inference",
            "",
            "schema",
            "model",
            "tokens",
            "runtime",
            "lock",
            "cargo",
            "wav",
        ],
    ];
    for arguments in cases {
        let output = Command::new(HOST)
            .args(arguments)
            .output()
            .expect("run fault host with invalid arguments");
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert_eq!(output.stderr, b"SHERPA_CONFORMANCE_USAGE\n");
    }
}
