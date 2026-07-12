#![cfg(all(feature = "native-sherpa", debug_assertions))]

use std::process::Command;

const HOST: &str = env!("CARGO_BIN_EXE_meetingrelay-sherpa-candidate-host");

#[test]
fn debug_candidate_host_rejects_provenance_emission() {
    let schema = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tools/sherpa-native/candidate-schema-registry.json");
    let output = Command::new(HOST)
        .arg(schema)
        .output()
        .expect("run debug candidate host");

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(output.stderr, b"SHERPA_PROVENANCE_RELEASE_REQUIRED\n");
}

#[test]
fn candidate_host_requires_exactly_one_schema_registry_argument() {
    for arguments in [Vec::<&str>::new(), vec!["one", "two"]] {
        let output = Command::new(HOST)
            .args(arguments)
            .output()
            .expect("run candidate host with invalid arguments");
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert_eq!(output.stderr, b"SHERPA_PROVENANCE_USAGE\n");
    }
}
