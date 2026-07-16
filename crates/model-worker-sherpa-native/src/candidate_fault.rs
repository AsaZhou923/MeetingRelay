use std::str::FromStr;

#[cfg(any(feature = "native-sherpa", test))]
use std::fmt::Write as _;
#[cfg(any(feature = "native-sherpa", test))]
use std::fs::OpenOptions;
#[cfg(any(feature = "native-sherpa", test))]
use std::io::Write as _;
#[cfg(any(feature = "native-sherpa", test))]
use std::path::Path;
#[cfg(feature = "native-sherpa")]
use std::sync::Arc;

#[cfg(any(feature = "native-sherpa", test))]
use sha2::{Digest, Sha256};

#[cfg(feature = "native-sherpa")]
use crate::candidate_execution::{
    LOCKED_CONFORMANCE_WAV_SHA256_HEX, NativeCandidateCheckpoint,
    NativeCandidateCheckpointObserver, NativeCandidateExecutionError,
    NativeCandidateExecutionInput, run_locked_native_candidate_conformance_with_observer,
};
#[cfg(any(feature = "native-sherpa", test))]
use crate::{
    LOCKED_ASSET_LOCK_SHA256_HEX, LOCKED_MODEL_SHA256_HEX, LOCKED_PACKAGE_LOCK_SHA256_HEX,
    LOCKED_PARAMETER_SHA256_HEX, LOCKED_RUNTIME_BUNDLE_SHA256_HEX, LOCKED_TOKENS_SHA256_HEX,
};
#[cfg(feature = "native-sherpa")]
use crate::{RUNTIME_ASSETS, locked_schema_registry_sha256, sha256_file};

pub const NATIVE_CANDIDATE_FAULT_CHECKPOINT_KIND: &str =
    "meetingrelay-native-candidate-fault-checkpoint-v1";
#[cfg(any(feature = "native-sherpa", test))]
const SCHEMA_VERSION: &str = "1.0";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeCandidateFaultMode {
    AbortAfterPrepare,
    HangAfterInference,
}

impl NativeCandidateFaultMode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AbortAfterPrepare => "abort-after-prepare",
            Self::HangAfterInference => "hang-after-inference",
        }
    }
}

impl FromStr for NativeCandidateFaultMode {
    type Err = ();

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "abort-after-prepare" => Ok(Self::AbortAfterPrepare),
            "hang-after-inference" => Ok(Self::HangAfterInference),
            _ => Err(()),
        }
    }
}

#[cfg(any(feature = "native-sherpa", test))]
#[derive(Clone, Copy)]
struct RuntimeDllIdentity<'a> {
    name: &'a str,
    sha256: &'a str,
}

#[cfg(any(feature = "native-sherpa", test))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FaultCheckpoint {
    RealPrepareLoadedRuntimeIdentity,
    SuccessfulRealInference,
}

#[cfg(any(feature = "native-sherpa", test))]
impl FaultCheckpoint {
    const fn as_str(self) -> &'static str {
        match self {
            Self::RealPrepareLoadedRuntimeIdentity => "real-prepare-loaded-runtime-identity",
            Self::SuccessfulRealInference => "successful-real-inference",
        }
    }
}

#[cfg(any(feature = "native-sherpa", test))]
struct MarkerInput<'a> {
    backend_execute_calls: Option<usize>,
    checkpoint: FaultCheckpoint,
    locked_input_snapshot_sha256: &'a str,
    mode: NativeCandidateFaultMode,
    process_id: u32,
    runtime_dlls: [RuntimeDllIdentity<'a>; 2],
    self_sha256: &'a str,
}

#[cfg(any(feature = "native-sherpa", test))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct MarkerError;

#[cfg(feature = "native-sherpa")]
pub fn run_locked_native_candidate_fault(
    mode: NativeCandidateFaultMode,
    marker_path: &Path,
    input: NativeCandidateExecutionInput,
) -> Result<(), NativeCandidateExecutionError> {
    if !marker_path.is_absolute() {
        return Err(NativeCandidateExecutionError::InvalidInput);
    }
    let observer = Arc::new(FaultObserver::new(mode, marker_path, &input)?);
    match run_locked_native_candidate_conformance_with_observer(input, observer) {
        Ok(_) => Err(NativeCandidateExecutionError::Checkpoint),
        Err(error) => Err(error),
    }
}

#[cfg(feature = "native-sherpa")]
struct FaultObserver {
    locked_input_snapshot_sha256: String,
    marker_path: std::path::PathBuf,
    mode: NativeCandidateFaultMode,
    runtime_dlls: [RuntimeDllIdentity<'static>; 2],
    self_sha256: String,
}

#[cfg(feature = "native-sherpa")]
impl FaultObserver {
    fn new(
        mode: NativeCandidateFaultMode,
        marker_path: &Path,
        input: &NativeCandidateExecutionInput,
    ) -> Result<Self, NativeCandidateExecutionError> {
        let self_sha256 = sha256_file(&input.executable_path)
            .map_err(|_| NativeCandidateExecutionError::AssetUnavailable)?
            .to_lower_hex();
        let schema_registry_sha256 = locked_schema_registry_sha256(&input.schema_registry_path)
            .map_err(|_| NativeCandidateExecutionError::Provenance)?
            .to_lower_hex();
        let locked_input_snapshot_sha256 = locked_input_snapshot_sha256(
            &schema_registry_sha256,
            LOCKED_CONFORMANCE_WAV_SHA256_HEX,
        );
        Ok(Self {
            locked_input_snapshot_sha256,
            marker_path: marker_path.to_path_buf(),
            mode,
            runtime_dlls: locked_runtime_dlls()?,
            self_sha256,
        })
    }

    fn terminate_at(
        &self,
        checkpoint: FaultCheckpoint,
        backend_execute_calls: Option<usize>,
    ) -> Result<(), NativeCandidateExecutionError> {
        let marker = encode_marker(MarkerInput {
            backend_execute_calls,
            checkpoint,
            locked_input_snapshot_sha256: &self.locked_input_snapshot_sha256,
            mode: self.mode,
            process_id: std::process::id(),
            runtime_dlls: self.runtime_dlls,
            self_sha256: &self.self_sha256,
        })
        .map_err(|MarkerError| NativeCandidateExecutionError::Checkpoint)?;
        write_new_marker(&self.marker_path, &marker)
            .map_err(|MarkerError| NativeCandidateExecutionError::Checkpoint)?;
        match self.mode {
            NativeCandidateFaultMode::AbortAfterPrepare => std::process::abort(),
            NativeCandidateFaultMode::HangAfterInference => loop {
                std::thread::park();
            },
        }
    }
}

#[cfg(feature = "native-sherpa")]
impl NativeCandidateCheckpointObserver for FaultObserver {
    fn observe(
        &self,
        checkpoint: NativeCandidateCheckpoint,
    ) -> Result<(), NativeCandidateExecutionError> {
        match (self.mode, checkpoint) {
            (
                NativeCandidateFaultMode::AbortAfterPrepare,
                NativeCandidateCheckpoint::RealPrepareLoadedRuntimeIdentity,
            ) => self.terminate_at(FaultCheckpoint::RealPrepareLoadedRuntimeIdentity, None),
            (
                NativeCandidateFaultMode::HangAfterInference,
                NativeCandidateCheckpoint::SuccessfulRealInference {
                    backend_execute_calls: 1,
                },
            ) => self.terminate_at(FaultCheckpoint::SuccessfulRealInference, Some(1)),
            (
                NativeCandidateFaultMode::HangAfterInference,
                NativeCandidateCheckpoint::SuccessfulRealInference { .. },
            ) => Err(NativeCandidateExecutionError::Observation),
            _ => Ok(()),
        }
    }
}

#[cfg(feature = "native-sherpa")]
fn locked_runtime_dlls() -> Result<[RuntimeDllIdentity<'static>; 2], NativeCandidateExecutionError>
{
    fn find(
        name: &'static str,
    ) -> Result<RuntimeDllIdentity<'static>, NativeCandidateExecutionError> {
        let asset = RUNTIME_ASSETS
            .iter()
            .find(|asset| asset.name == name)
            .ok_or(NativeCandidateExecutionError::Provenance)?;
        Ok(RuntimeDllIdentity {
            name: asset.name,
            sha256: asset.sha256,
        })
    }

    Ok([find("onnxruntime.dll")?, find("sherpa-onnx-c-api.dll")?])
}

#[cfg(any(feature = "native-sherpa", test))]
fn locked_input_snapshot_material(schema_registry_sha256: &str, wav_sha256: &str) -> String {
    format!(
        concat!(
            "{{\"asset_lock_sha256\":\"{}\",\"cargo_lock_sha256\":\"{}\",",
            "\"model_sha256\":\"{}\",\"parameter_sha256\":\"{}\",",
            "\"runtime_bundle_sha256\":\"{}\",\"schema_registry_sha256\":\"{}\",",
            "\"tokens_sha256\":\"{}\",\"wav_sha256\":\"{}\"}}"
        ),
        LOCKED_ASSET_LOCK_SHA256_HEX,
        LOCKED_PACKAGE_LOCK_SHA256_HEX,
        LOCKED_MODEL_SHA256_HEX,
        LOCKED_PARAMETER_SHA256_HEX,
        LOCKED_RUNTIME_BUNDLE_SHA256_HEX,
        schema_registry_sha256,
        LOCKED_TOKENS_SHA256_HEX,
        wav_sha256,
    )
}

#[cfg(any(feature = "native-sherpa", test))]
fn locked_input_snapshot_sha256(schema_registry_sha256: &str, wav_sha256: &str) -> String {
    lower_hex(&Sha256::digest(
        locked_input_snapshot_material(schema_registry_sha256, wav_sha256).as_bytes(),
    ))
}

#[cfg(any(feature = "native-sherpa", test))]
fn encode_marker(input: MarkerInput<'_>) -> Result<Vec<u8>, MarkerError> {
    let expected_execute_calls = match input.mode {
        NativeCandidateFaultMode::AbortAfterPrepare => None,
        NativeCandidateFaultMode::HangAfterInference => Some(1),
    };
    if input.backend_execute_calls != expected_execute_calls
        || (input.mode == NativeCandidateFaultMode::AbortAfterPrepare
            && input.checkpoint != FaultCheckpoint::RealPrepareLoadedRuntimeIdentity)
        || (input.mode == NativeCandidateFaultMode::HangAfterInference
            && input.checkpoint != FaultCheckpoint::SuccessfulRealInference)
        || !is_lower_sha256(input.locked_input_snapshot_sha256)
        || !is_lower_sha256(input.self_sha256)
        || input.runtime_dlls[0].name != "onnxruntime.dll"
        || input.runtime_dlls[1].name != "sherpa-onnx-c-api.dll"
        || input
            .runtime_dlls
            .iter()
            .any(|identity| !is_lower_sha256(identity.sha256))
    {
        return Err(MarkerError);
    }
    let mut output = String::with_capacity(768);
    if let Some(calls) = input.backend_execute_calls {
        write!(&mut output, "{{\"backend_execute_calls\":{calls},").map_err(|_| MarkerError)?;
    } else {
        output.push('{');
    }
    write!(
        &mut output,
        concat!(
            "\"checkpoint\":\"{}\",\"kind\":\"{}\",",
            "\"locked_input_snapshot_sha256\":\"{}\",\"mode\":\"{}\",",
            "\"process_id\":{},\"runtime_dlls\":["
        ),
        input.checkpoint.as_str(),
        NATIVE_CANDIDATE_FAULT_CHECKPOINT_KIND,
        input.locked_input_snapshot_sha256,
        input.mode.as_str(),
        input.process_id,
    )
    .map_err(|_| MarkerError)?;
    for (index, identity) in input.runtime_dlls.iter().enumerate() {
        if index != 0 {
            output.push(',');
        }
        write!(
            &mut output,
            "{{\"name\":\"{}\",\"sha256\":\"{}\"}}",
            identity.name, identity.sha256,
        )
        .map_err(|_| MarkerError)?;
    }
    writeln!(
        &mut output,
        "],\"schema_version\":\"{SCHEMA_VERSION}\",\"self_sha256\":\"{}\"}}",
        input.self_sha256,
    )
    .map_err(|_| MarkerError)?;
    Ok(output.into_bytes())
}

#[cfg(any(feature = "native-sherpa", test))]
fn write_new_marker(path: &Path, marker: &[u8]) -> Result<(), MarkerError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| MarkerError)?;
    file.write_all(marker).map_err(|_| MarkerError)?;
    file.sync_all().map_err(|_| MarkerError)
}

#[cfg(any(feature = "native-sherpa", test))]
fn is_lower_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(any(feature = "native-sherpa", test))]
fn lower_hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut output, "{byte:02x}").expect("writing to String cannot fail");
    }
    output
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const D: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

    #[test]
    fn modes_accept_only_the_two_explicit_faults() {
        assert_eq!(
            "abort-after-prepare".parse(),
            Ok(NativeCandidateFaultMode::AbortAfterPrepare)
        );
        assert_eq!(
            "hang-after-inference".parse(),
            Ok(NativeCandidateFaultMode::HangAfterInference)
        );
        assert_eq!("abort".parse::<NativeCandidateFaultMode>(), Err(()));
    }

    #[test]
    fn canonical_markers_have_exact_bounded_fields() {
        let runtime_dlls = [
            RuntimeDllIdentity {
                name: "onnxruntime.dll",
                sha256: C,
            },
            RuntimeDllIdentity {
                name: "sherpa-onnx-c-api.dll",
                sha256: D,
            },
        ];
        let abort = encode_marker(MarkerInput {
            backend_execute_calls: None,
            checkpoint: FaultCheckpoint::RealPrepareLoadedRuntimeIdentity,
            locked_input_snapshot_sha256: A,
            mode: NativeCandidateFaultMode::AbortAfterPrepare,
            process_id: 42,
            runtime_dlls,
            self_sha256: B,
        })
        .expect("encode abort marker");
        assert_eq!(
            String::from_utf8(abort).expect("abort marker UTF-8"),
            concat!(
                "{\"checkpoint\":\"real-prepare-loaded-runtime-identity\",",
                "\"kind\":\"meetingrelay-native-candidate-fault-checkpoint-v1\",",
                "\"locked_input_snapshot_sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",",
                "\"mode\":\"abort-after-prepare\",\"process_id\":42,",
                "\"runtime_dlls\":[{\"name\":\"onnxruntime.dll\",\"sha256\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\"},",
                "{\"name\":\"sherpa-onnx-c-api.dll\",\"sha256\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\"}],",
                "\"schema_version\":\"1.0\",\"self_sha256\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"}\n"
            )
        );
        let hang = encode_marker(MarkerInput {
            backend_execute_calls: Some(1),
            checkpoint: FaultCheckpoint::SuccessfulRealInference,
            locked_input_snapshot_sha256: A,
            mode: NativeCandidateFaultMode::HangAfterInference,
            process_id: 43,
            runtime_dlls,
            self_sha256: B,
        })
        .expect("encode hang marker");
        let hang = String::from_utf8(hang).expect("hang marker UTF-8");
        assert!(hang.starts_with("{\"backend_execute_calls\":1,"));
        for forbidden in [
            "\"path\"",
            "\"transcript\"",
            "\"timestamp\"",
            "\"run_id\"",
            "\"random\"",
        ] {
            assert!(!hang.contains(forbidden));
        }
    }

    #[test]
    fn snapshot_material_has_one_stable_canonical_order() {
        let material = locked_input_snapshot_material(A, B);
        assert!(material.starts_with("{\"asset_lock_sha256\":"));
        assert!(material.contains(&format!("\"schema_registry_sha256\":\"{A}\"")));
        assert!(material.ends_with(&format!("\"wav_sha256\":\"{B}\"}}")));
        assert_eq!(
            locked_input_snapshot_sha256(A, B),
            "9afb7908b493c1a5b30d7dff627e3affe092b152fe0624f2f43d97d809a6148d"
        );
        assert_eq!(
            lower_hex(&Sha256::digest(material.as_bytes())),
            "9afb7908b493c1a5b30d7dff627e3affe092b152fe0624f2f43d97d809a6148d"
        );
    }

    #[test]
    fn marker_creation_is_exclusive() {
        let directory = unique_test_directory("fault-marker");
        fs::create_dir_all(&directory).expect("create marker fixture directory");
        let marker_path = directory.join("marker.json");
        write_new_marker(&marker_path, b"first\n").expect("create first marker");
        assert_eq!(fs::read(&marker_path).expect("read marker"), b"first\n");
        assert_eq!(
            write_new_marker(&marker_path, b"second\n"),
            Err(MarkerError)
        );
        assert_eq!(fs::read(&marker_path).expect("re-read marker"), b"first\n");
        fs::remove_dir_all(directory).expect("remove marker fixture directory");
    }

    fn unique_test_directory(label: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock follows Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "meetingrelay-{label}-{}-{nonce}",
            std::process::id()
        ))
    }
}
