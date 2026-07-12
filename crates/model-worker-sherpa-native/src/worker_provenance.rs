use std::fmt;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use meetingrelay_model_worker_contract::{Identifier, Sha256Digest, WorkerManifest, WorkerRole};
use sha2::{Digest, Sha256};

use super::candidate_builder_input::push_descriptor_json;
use super::locked_engine_descriptor;

pub const LOCKED_WORKER_ID: &str = "meetingrelay-sherpa-native-candidate-host-v1";
pub const LOCKED_SCHEMA_REGISTRY_BYTES: &[u8] =
    include_bytes!("../../../tools/sherpa-native/candidate-schema-registry.json");
pub const MAX_SCHEMA_REGISTRY_BYTES: u64 = 65_536;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerProvenanceError {
    ZeroExecutableDigest,
    ZeroSchemaRegistryDigest,
    SchemaRegistryUnavailable,
    SchemaRegistryReparse,
    SchemaRegistryNotRegular,
    SchemaRegistrySize,
    SchemaRegistryBytesMismatch,
}

impl WorkerProvenanceError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::ZeroExecutableDigest => "SHERPA_PROVENANCE_ZERO_EXECUTABLE_DIGEST",
            Self::ZeroSchemaRegistryDigest => "SHERPA_PROVENANCE_ZERO_SCHEMA_DIGEST",
            Self::SchemaRegistryUnavailable => "SHERPA_PROVENANCE_SCHEMA_UNAVAILABLE",
            Self::SchemaRegistryReparse => "SHERPA_PROVENANCE_SCHEMA_REPARSE",
            Self::SchemaRegistryNotRegular => "SHERPA_PROVENANCE_SCHEMA_NOT_REGULAR",
            Self::SchemaRegistrySize => "SHERPA_PROVENANCE_SCHEMA_SIZE",
            Self::SchemaRegistryBytesMismatch => "SHERPA_PROVENANCE_SCHEMA_BYTES",
        }
    }
}

impl fmt::Display for WorkerProvenanceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for WorkerProvenanceError {}

pub fn locked_worker_manifest(
    executable_sha256: Sha256Digest,
    schema_registry_sha256: Sha256Digest,
) -> Result<WorkerManifest, WorkerProvenanceError> {
    if executable_sha256.is_zero() {
        return Err(WorkerProvenanceError::ZeroExecutableDigest);
    }
    if schema_registry_sha256.is_zero() {
        return Err(WorkerProvenanceError::ZeroSchemaRegistryDigest);
    }
    Ok(WorkerManifest {
        worker_id: Identifier::new(LOCKED_WORKER_ID)
            .expect("committed worker identity is constant-valid"),
        role: WorkerRole::NativeCandidate,
        worker_build_sha256: executable_sha256,
        executable_sha256,
        schema_registry_sha256,
        descriptor: locked_engine_descriptor(),
    })
}

pub fn locked_worker_manifest_projection_json_bytes(
    executable_sha256: Sha256Digest,
    schema_registry_sha256: Sha256Digest,
) -> Result<Vec<u8>, WorkerProvenanceError> {
    let manifest = locked_worker_manifest(executable_sha256, schema_registry_sha256)?;
    let executable = manifest.executable_sha256.to_lower_hex();
    let schema = manifest.schema_registry_sha256.to_lower_hex();
    let mut output = String::with_capacity(1_024);
    output.push_str("{\"descriptor\":");
    push_descriptor_json(&mut output, &manifest.descriptor);
    output.push_str(",\"executable_sha256\":\"");
    output.push_str(&executable);
    output.push_str("\",\"role\":\"native-candidate\",\"schema_registry_sha256\":\"");
    output.push_str(&schema);
    output.push_str("\",\"worker_build_sha256\":\"");
    output.push_str(&executable);
    output.push_str("\",\"worker_id\":\"");
    output.push_str(manifest.worker_id.as_str());
    output.push_str("\"}\n");
    Ok(output.into_bytes())
}

pub fn locked_schema_registry_sha256(path: &Path) -> Result<Sha256Digest, WorkerProvenanceError> {
    reject_reparse_path(path)?;
    let path_metadata = std::fs::symlink_metadata(path)
        .map_err(|_| WorkerProvenanceError::SchemaRegistryUnavailable)?;
    if !path_metadata.file_type().is_file() {
        return Err(WorkerProvenanceError::SchemaRegistryNotRegular);
    }
    let mut file =
        File::open(path).map_err(|_| WorkerProvenanceError::SchemaRegistryUnavailable)?;
    let metadata = file
        .metadata()
        .map_err(|_| WorkerProvenanceError::SchemaRegistryUnavailable)?;
    if !metadata.is_file() {
        return Err(WorkerProvenanceError::SchemaRegistryNotRegular);
    }
    if metadata.len() == 0 || metadata.len() > MAX_SCHEMA_REGISTRY_BYTES {
        return Err(WorkerProvenanceError::SchemaRegistrySize);
    }
    let mut bytes = Vec::with_capacity(
        usize::try_from(metadata.len()).map_err(|_| WorkerProvenanceError::SchemaRegistrySize)?,
    );
    file.read_to_end(&mut bytes)
        .map_err(|_| WorkerProvenanceError::SchemaRegistryUnavailable)?;
    if bytes.as_slice() != LOCKED_SCHEMA_REGISTRY_BYTES {
        return Err(WorkerProvenanceError::SchemaRegistryBytesMismatch);
    }
    Ok(Sha256Digest::from_bytes(Sha256::digest(&bytes).into()))
}

fn reject_reparse_path(path: &Path) -> Result<(), WorkerProvenanceError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|_| WorkerProvenanceError::SchemaRegistryUnavailable)?
            .join(path)
    };
    for component in absolute.ancestors() {
        let metadata = std::fs::symlink_metadata(component)
            .map_err(|_| WorkerProvenanceError::SchemaRegistryUnavailable)?;
        if metadata.file_type().is_symlink() || is_windows_reparse_point(&metadata) {
            return Err(WorkerProvenanceError::SchemaRegistryReparse);
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_windows_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
const fn is_windows_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}
