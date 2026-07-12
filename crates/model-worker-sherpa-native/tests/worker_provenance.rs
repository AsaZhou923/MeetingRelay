use meetingrelay_model_worker_contract::{Sha256Digest, WorkerRole};
use meetingrelay_model_worker_sherpa_native::{
    LOCKED_SCHEMA_REGISTRY_BYTES, LOCKED_WORKER_ID, MAX_SCHEMA_REGISTRY_BYTES,
    WorkerProvenanceError, locked_candidate_builder_input_json_bytes, locked_engine_descriptor,
    locked_schema_registry_sha256, locked_worker_manifest,
    locked_worker_manifest_projection_json_bytes,
};

fn digest(byte: u8) -> Sha256Digest {
    Sha256Digest::from_bytes([byte; 32])
}

#[test]
fn locked_worker_manifest_uses_rust_owned_identity_and_exact_provenance() {
    let executable = digest(1);
    let schema = digest(2);
    let manifest = locked_worker_manifest(executable, schema).expect("non-zero provenance");

    assert_eq!(
        LOCKED_WORKER_ID,
        "meetingrelay-sherpa-native-candidate-host-v1"
    );
    assert_eq!(manifest.worker_id.as_str(), LOCKED_WORKER_ID);
    assert_eq!(manifest.role, WorkerRole::NativeCandidate);
    assert_eq!(manifest.worker_build_sha256, executable);
    assert_eq!(manifest.executable_sha256, executable);
    assert_eq!(manifest.schema_registry_sha256, schema);
    assert_eq!(manifest.descriptor, locked_engine_descriptor());
}

#[test]
fn locked_worker_manifest_rejects_each_zero_provenance_digest() {
    let zero = Sha256Digest::from_bytes([0; 32]);

    assert_eq!(
        locked_worker_manifest(zero, digest(2)),
        Err(WorkerProvenanceError::ZeroExecutableDigest)
    );
    assert_eq!(
        locked_worker_manifest(digest(1), zero),
        Err(WorkerProvenanceError::ZeroSchemaRegistryDigest)
    );
}

#[test]
fn worker_manifest_projection_is_exact_canonical_six_field_json() {
    let bytes = locked_worker_manifest_projection_json_bytes(digest(1), digest(2))
        .expect("non-zero provenance");
    let text = std::str::from_utf8(&bytes).expect("projection must be UTF-8");
    let builder = String::from_utf8(locked_candidate_builder_input_json_bytes())
        .expect("builder input UTF-8");
    let descriptor = builder
        .split_once("\"worker_manifest_descriptor_fragment\":")
        .expect("builder descriptor")
        .1
        .split_once(",\"worker_role\":")
        .expect("builder role")
        .0;
    let expected = format!(
        concat!(
            "{{\"descriptor\":{},",
            "\"executable_sha256\":\"{}\",",
            "\"role\":\"native-candidate\",",
            "\"schema_registry_sha256\":\"{}\",",
            "\"worker_build_sha256\":\"{}\",",
            "\"worker_id\":\"meetingrelay-sherpa-native-candidate-host-v1\"}}\n"
        ),
        descriptor,
        "01".repeat(32),
        "02".repeat(32),
        "01".repeat(32),
    );

    assert_eq!(bytes, expected.as_bytes());
    for forbidden in [
        "artifact_scope",
        "expectedContractSha256",
        "execution_status",
        "quality_evidence",
        "selection_status",
        "publishability_status",
        "status",
    ] {
        assert!(!text.contains(forbidden), "forbidden field: {forbidden}");
    }
}

#[test]
fn worker_manifest_descriptor_bytes_equal_the_candidate_builder_fragment() {
    let projection = String::from_utf8(
        locked_worker_manifest_projection_json_bytes(digest(1), digest(2))
            .expect("non-zero provenance"),
    )
    .expect("projection UTF-8");
    let builder = String::from_utf8(locked_candidate_builder_input_json_bytes())
        .expect("builder input UTF-8");
    let descriptor = builder
        .split_once("\"worker_manifest_descriptor_fragment\":")
        .expect("builder descriptor")
        .1
        .split_once(",\"worker_role\":")
        .expect("builder role")
        .0;

    assert!(projection.starts_with(&format!("{{\"descriptor\":{descriptor},")));
}

#[test]
fn committed_schema_registry_bytes_are_the_only_accepted_schema_input() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tools/sherpa-native/candidate-schema-registry.json");
    let digest = locked_schema_registry_sha256(&path).expect("committed schema registry");

    assert!(!digest.is_zero());
    assert_eq!(
        std::fs::read(path).expect("read committed schema"),
        LOCKED_SCHEMA_REGISTRY_BYTES
    );
}

fn with_schema_fixture(bytes: &[u8], run: impl FnOnce(&std::path::Path)) {
    let unique = format!(
        "meetingrelay-worker-provenance-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos()
    );
    let root = std::env::temp_dir().join(unique);
    std::fs::create_dir(&root).expect("create schema fixture root");
    let path = root.join("candidate-schema-registry.json");
    std::fs::write(&path, bytes).expect("write schema fixture");
    run(&path);
    std::fs::remove_dir_all(root).expect("remove schema fixture root");
}

#[test]
fn schema_registry_byte_tampering_fails_closed() {
    let mut tampered = LOCKED_SCHEMA_REGISTRY_BYTES.to_vec();
    tampered.push(b' ');
    with_schema_fixture(&tampered, |path| {
        assert_eq!(
            locked_schema_registry_sha256(path),
            Err(WorkerProvenanceError::SchemaRegistryBytesMismatch)
        );
    });
}

#[test]
fn schema_registry_empty_and_oversize_inputs_fail_the_size_bound() {
    for bytes in [
        Vec::new(),
        vec![b'a'; MAX_SCHEMA_REGISTRY_BYTES as usize + 1],
    ] {
        with_schema_fixture(&bytes, |path| {
            assert_eq!(
                locked_schema_registry_sha256(path),
                Err(WorkerProvenanceError::SchemaRegistrySize)
            );
        });
    }
}

#[test]
fn schema_registry_directories_are_not_regular_inputs() {
    let root = std::env::temp_dir().join(format!(
        "meetingrelay-worker-provenance-directory-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&root).expect("create schema directory fixture");
    assert_eq!(
        locked_schema_registry_sha256(&root),
        Err(WorkerProvenanceError::SchemaRegistryNotRegular)
    );
    std::fs::remove_dir_all(root).expect("remove schema directory fixture");
}

#[test]
fn schema_registry_reparse_ancestors_fail_closed() {
    let root = std::env::temp_dir().join(format!(
        "meetingrelay-worker-provenance-reparse-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos()
    ));
    let target = root.join("target");
    let linked = root.join("linked");
    std::fs::create_dir_all(&target).expect("create schema reparse target");
    std::fs::write(
        target.join("candidate-schema-registry.json"),
        LOCKED_SCHEMA_REGISTRY_BYTES,
    )
    .expect("write schema below reparse target");
    create_directory_link(&target, &linked);

    assert_eq!(
        locked_schema_registry_sha256(&linked.join("candidate-schema-registry.json")),
        Err(WorkerProvenanceError::SchemaRegistryReparse)
    );

    std::fs::remove_dir(&linked).expect("remove schema reparse link");
    std::fs::remove_dir_all(root).expect("remove schema reparse fixture");
}

#[cfg(windows)]
fn create_directory_link(target: &std::path::Path, linked: &std::path::Path) {
    let output = std::process::Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(linked)
        .arg(target)
        .output()
        .expect("run mklink for schema reparse fixture");
    assert!(output.status.success(), "mklink /J must succeed in CI");
}

#[cfg(unix)]
fn create_directory_link(target: &std::path::Path, linked: &std::path::Path) {
    std::os::unix::fs::symlink(target, linked).expect("create schema directory symlink");
}
