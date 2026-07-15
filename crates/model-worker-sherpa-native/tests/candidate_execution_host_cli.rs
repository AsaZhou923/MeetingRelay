#![cfg(all(feature = "native-sherpa", debug_assertions))]

use std::process::Command;

const HOST: &str = env!("CARGO_BIN_EXE_meetingrelay-sherpa-candidate-execution-host");

#[test]
fn debug_execution_host_rejects_conformance_emission() {
    let output = Command::new(HOST)
        .args([
            "schema", "model", "tokens", "runtime", "lock", "cargo", "wav",
        ])
        .output()
        .expect("run debug execution host");

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(output.stderr, b"SHERPA_CONFORMANCE_RELEASE_REQUIRED\n");
}

#[test]
fn execution_host_requires_exactly_seven_nonempty_paths() {
    for arguments in [
        Vec::<&str>::new(),
        vec!["one"],
        vec!["one", "two", "three", "four", "five", "six"],
        vec![
            "one", "two", "three", "four", "five", "six", "seven", "eight",
        ],
        vec!["one", "two", "three", "four", "five", "six", ""],
    ] {
        let output = Command::new(HOST)
            .args(arguments)
            .output()
            .expect("run execution host with invalid arguments");
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert_eq!(output.stderr, b"SHERPA_CONFORMANCE_USAGE\n");
    }
}
