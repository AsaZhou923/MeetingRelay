use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use meetingrelay_model_worker_contract::{
    Architecture, AudioChunk, AudioFormat, AudioGap, AudioPayload, AudioSource, BackendAction,
    BackendFailure, BackendOutcome, CandidateConformanceError, CapabilitySet, ContractError,
    ContractPurpose, DirectWorkerSession, ExecutionProvider, GapReason, HelloRequest, Identifier,
    JobKey, LanguageCode, ModelBackend, MonotonicDeadline, OperatingSystem, Platform,
    PrepareRequest, RequestContext, SampleFormat, Sha256Digest, SourceRange, TransportKind,
    WORKER_PROTOCOL_V1, WorkerCommand, WorkerEndpoint, WorkerEvent, WorkerLimits, WorkerManifest,
    WorkerRequest, WorkerResponse, WorkerRole, run_native_candidate_semantic_conformance,
};
use sha2::{Digest, Sha256};

use crate::candidate_builder_input::push_descriptor_json;
use crate::{
    LOCKED_ASSET_LOCK_SHA256_HEX, LOCKED_MODEL_SHA256_HEX, LOCKED_PACKAGE_LOCK_SHA256_HEX,
    LOCKED_PARAMETER_SHA256_HEX, LOCKED_RUNTIME_BUNDLE_SHA256_HEX, LOCKED_TOKENS_SHA256_HEX,
    RUNTIME_ASSETS, RuntimeAsset, SherpaNativeBackend, SherpaNativeConfig, WorkerProvenanceError,
    locked_engine_descriptor, locked_schema_registry_sha256, locked_worker_manifest, sha256_file,
};

pub const LOCKED_CONFORMANCE_WAV_SHA256_HEX: &str =
    "b77f1794fe374a0ba1ee1dc458bfaf9349496cbbfc32780c50ba3c5a7ad8e373";
const LOCKED_CONFORMANCE_WAV_SIZE_BYTES: u64 = 178_988;

const MODULE_PROBE_READY_FILE_ENV: &str = "MEETINGRELAY_SHERPA_MODULE_PROBE_READY_FILE";
const MODULE_PROBE_HOLD_MS_ENV: &str = "MEETINGRELAY_SHERPA_MODULE_PROBE_HOLD_MS";
const MODULE_PROBE_BACKEND_FAILURE: &str = "SHERPA_MODULE_PROBE_UNAVAILABLE";
const RUNTIME_IDENTITY_BACKEND_FAILURE: &str = "SHERPA_RUNTIME_IDENTITY_UNAVAILABLE";
#[cfg(feature = "native-fault-fixture")]
const CHECKPOINT_BACKEND_FAILURE: &str = "SHERPA_CHECKPOINT_UNAVAILABLE";
const REQUIRED_LOADED_RUNTIME_MODULES: [&str; 2] = ["sherpa-onnx-c-api.dll", "onnxruntime.dll"];
const LOCKED_STAGED_RUNTIME_DLL_COUNT: usize = 4;

#[derive(Clone)]
pub struct NativeCandidateExecutionInput {
    pub executable_path: PathBuf,
    pub schema_registry_path: PathBuf,
    pub model_path: PathBuf,
    pub tokens_path: PathBuf,
    pub runtime_lib_dir: PathBuf,
    pub asset_lock_path: PathBuf,
    pub package_lock_path: PathBuf,
    pub wav_path: PathBuf,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeCandidateExecutionError {
    InvalidInput,
    AssetUnavailable,
    AssetMismatch,
    Configuration,
    Contract,
    Observation,
    Provenance,
    ModuleProbeConfiguration,
    ModuleProbeUnavailable,
    #[cfg(feature = "native-fault-fixture")]
    Checkpoint,
}

impl NativeCandidateExecutionError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidInput => "SHERPA_CONFORMANCE_INVALID_INPUT",
            Self::AssetUnavailable => "SHERPA_CONFORMANCE_ASSET_UNAVAILABLE",
            Self::AssetMismatch => "SHERPA_CONFORMANCE_ASSET_MISMATCH",
            Self::Configuration => "SHERPA_CONFORMANCE_CONFIGURATION",
            Self::Contract => "SHERPA_CONFORMANCE_CONTRACT",
            Self::Observation => "SHERPA_CONFORMANCE_OBSERVATION",
            Self::Provenance => "SHERPA_CONFORMANCE_PROVENANCE",
            Self::ModuleProbeConfiguration => "SHERPA_CONFORMANCE_MODULE_PROBE_CONFIGURATION",
            Self::ModuleProbeUnavailable => "SHERPA_CONFORMANCE_MODULE_PROBE_UNAVAILABLE",
            #[cfg(feature = "native-fault-fixture")]
            Self::Checkpoint => "SHERPA_CONFORMANCE_CHECKPOINT_UNAVAILABLE",
        }
    }
}

impl fmt::Display for NativeCandidateExecutionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for NativeCandidateExecutionError {}

#[cfg(feature = "native-fault-fixture")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NativeCandidateCheckpoint {
    RealPrepareLoadedRuntimeIdentity,
    SuccessfulRealInference { backend_execute_calls: usize },
}

#[cfg(feature = "native-fault-fixture")]
pub(crate) trait NativeCandidateCheckpointObserver: Send + Sync {
    fn observe(
        &self,
        checkpoint: NativeCandidateCheckpoint,
    ) -> Result<(), NativeCandidateExecutionError>;
}

#[cfg(feature = "native-fault-fixture")]
type CheckpointObserver = Arc<dyn NativeCandidateCheckpointObserver>;

/// Executes the locked native adapter through the Rust semantic contract and
/// returns one canonical supporting-conformance JSON line.
///
/// The record cannot authorize formal claims or production evidence. The
/// executable is an outer crash-containment boundary only; the native worker
/// still negotiates the protocol-required in-process transport.
pub fn run_locked_native_candidate_conformance(
    input: NativeCandidateExecutionInput,
) -> Result<Vec<u8>, NativeCandidateExecutionError> {
    #[cfg(feature = "native-fault-fixture")]
    {
        run_locked_native_candidate_conformance_inner(input, None)
    }
    #[cfg(not(feature = "native-fault-fixture"))]
    {
        run_locked_native_candidate_conformance_inner(input)
    }
}

#[cfg(feature = "native-fault-fixture")]
pub(crate) fn run_locked_native_candidate_conformance_with_observer(
    input: NativeCandidateExecutionInput,
    observer: CheckpointObserver,
) -> Result<Vec<u8>, NativeCandidateExecutionError> {
    run_locked_native_candidate_conformance_inner(input, Some(observer))
}

fn run_locked_native_candidate_conformance_inner(
    input: NativeCandidateExecutionInput,
    #[cfg(feature = "native-fault-fixture")] observer: Option<CheckpointObserver>,
) -> Result<Vec<u8>, NativeCandidateExecutionError> {
    validate_absolute_inputs(&input)?;
    let module_probe = module_probe_configuration(
        std::env::var_os(MODULE_PROBE_READY_FILE_ENV),
        std::env::var_os(MODULE_PROBE_HOLD_MS_ENV),
    )?;
    let executable_sha256 = sha256_file(&input.executable_path)
        .map_err(|_| NativeCandidateExecutionError::AssetUnavailable)?;
    let schema_registry_sha256 =
        locked_schema_registry_sha256(&input.schema_registry_path).map_err(map_provenance_error)?;
    let manifest = locked_worker_manifest(executable_sha256, schema_registry_sha256)
        .map_err(map_provenance_error)?;
    let (samples, wav_sha256) = read_verified_mono_pcm16_wav(
        &input.wav_path,
        LOCKED_CONFORMANCE_WAV_SIZE_BYTES,
        digest_from_hex(LOCKED_CONFORMANCE_WAV_SHA256_HEX)?,
    )?;
    let (first_audio, gap, second_audio) = split_conformance_audio(&samples)?;
    let limits = conformance_limits();

    let execute_calls = Arc::new(AtomicUsize::new(0));
    let module_probe_failure = Arc::new(AtomicUsize::new(0));
    let runtime_identity_failure = Arc::new(AtomicUsize::new(0));
    #[cfg(feature = "native-fault-fixture")]
    let checkpoint_failure = Arc::new(AtomicUsize::new(0));
    let backend = SherpaNativeBackend::new(locked_config(&input)?)
        .map_err(|_| NativeCandidateExecutionError::Configuration)?;
    let counting = CountingBackend {
        inner: backend,
        execute_calls: Arc::clone(&execute_calls),
        executable_path: input.executable_path.clone(),
        module_probe,
        module_probe_failure: Arc::clone(&module_probe_failure),
        runtime_identity_failure: Arc::clone(&runtime_identity_failure),
        #[cfg(feature = "native-fault-fixture")]
        checkpoint_failure: Arc::clone(&checkpoint_failure),
        #[cfg(feature = "native-fault-fixture")]
        observer: observer.clone(),
    };
    let mut session =
        DirectWorkerSession::new(manifest.clone(), limits, counting).map_err(map_contract_error)?;
    let observation = run_native_candidate_semantic_conformance(
        &mut session,
        hello_request(manifest.clone(), limits),
        Identifier::new("core-fixture-clock")
            .map_err(|_| NativeCandidateExecutionError::Contract)?,
        first_audio.clone(),
        gap,
        second_audio,
    );
    if runtime_identity_failure.load(Ordering::Relaxed) != 0 {
        return Err(NativeCandidateExecutionError::Provenance);
    }
    if module_probe_failure.load(Ordering::Relaxed) != 0 {
        return Err(NativeCandidateExecutionError::ModuleProbeUnavailable);
    }
    #[cfg(feature = "native-fault-fixture")]
    if checkpoint_failure.load(Ordering::Relaxed) != 0 {
        return Err(NativeCandidateExecutionError::Checkpoint);
    }
    let observation = observation.map_err(map_conformance_error)?;
    let backend_execute_calls = execute_calls.load(Ordering::Relaxed);
    if backend_execute_calls != 1 {
        return Err(NativeCandidateExecutionError::Observation);
    }
    #[cfg(feature = "native-fault-fixture")]
    observe_checkpoint(
        observer.as_ref(),
        NativeCandidateCheckpoint::SuccessfulRealInference {
            backend_execute_calls,
        },
    )?;
    drop(session);

    run_stable_failure_lane(&input, &manifest, limits)?;
    run_rust_panic_lane(&input, &manifest, limits, first_audio)?;
    validate_loaded_runtime_identity(&input.executable_path)?;

    let transcript = observation
        .final_result
        .original_transcript
        .as_str()
        .as_bytes();
    let final_transcript_sha256 = Sha256Digest::from_bytes(Sha256::digest(transcript).into());
    if observation.final_transcript_utf8_bytes != transcript.len() || transcript.is_empty() {
        return Err(NativeCandidateExecutionError::Observation);
    }
    encode_record(
        &manifest,
        final_transcript_sha256,
        observation.final_transcript_utf8_bytes,
        wav_sha256,
    )
}

struct CountingBackend {
    inner: SherpaNativeBackend,
    execute_calls: Arc<AtomicUsize>,
    executable_path: PathBuf,
    module_probe: Option<ModuleProbeConfiguration>,
    module_probe_failure: Arc<AtomicUsize>,
    runtime_identity_failure: Arc<AtomicUsize>,
    #[cfg(feature = "native-fault-fixture")]
    checkpoint_failure: Arc<AtomicUsize>,
    #[cfg(feature = "native-fault-fixture")]
    observer: Option<CheckpointObserver>,
}

impl ModelBackend for CountingBackend {
    fn prepare(&mut self) -> Result<(), BackendFailure> {
        self.inner.prepare()?;
        if validate_loaded_runtime_identity(&self.executable_path).is_err() {
            self.runtime_identity_failure.store(1, Ordering::Relaxed);
            return Err(BackendFailure::new(
                Identifier::new(RUNTIME_IDENTITY_BACKEND_FAILURE)
                    .expect("stable runtime-identity failure code is constant-valid"),
                false,
                None,
            ));
        }
        if let Some(configuration) = self.module_probe.take()
            && publish_module_probe_ready(&configuration).is_err()
        {
            self.module_probe_failure.store(1, Ordering::Relaxed);
            return Err(BackendFailure::new(
                Identifier::new(MODULE_PROBE_BACKEND_FAILURE)
                    .expect("stable module-probe failure code is constant-valid"),
                false,
                None,
            ));
        }
        #[cfg(feature = "native-fault-fixture")]
        if observe_checkpoint(
            self.observer.as_ref(),
            NativeCandidateCheckpoint::RealPrepareLoadedRuntimeIdentity,
        )
        .is_err()
        {
            self.checkpoint_failure.store(1, Ordering::Relaxed);
            return Err(BackendFailure::new(
                Identifier::new(CHECKPOINT_BACKEND_FAILURE)
                    .expect("stable checkpoint failure code is constant-valid"),
                false,
                None,
            ));
        }
        Ok(())
    }

    fn execute(&mut self, action: &BackendAction) -> BackendOutcome {
        self.execute_calls.fetch_add(1, Ordering::Relaxed);
        self.inner.execute(action)
    }
}

#[cfg(feature = "native-fault-fixture")]
fn observe_checkpoint(
    observer: Option<&CheckpointObserver>,
    checkpoint: NativeCandidateCheckpoint,
) -> Result<(), NativeCandidateExecutionError> {
    match observer {
        Some(observer) => observer.observe(checkpoint),
        None => Ok(()),
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ModuleProbeConfiguration {
    ready_file: PathBuf,
    hold: Duration,
}

fn module_probe_configuration(
    ready_file: Option<OsString>,
    hold_ms: Option<OsString>,
) -> Result<Option<ModuleProbeConfiguration>, NativeCandidateExecutionError> {
    match (ready_file, hold_ms) {
        (None, None) => Ok(None),
        (Some(ready_file), Some(hold_ms)) if !ready_file.is_empty() => {
            let hold_ms = hold_ms
                .to_str()
                .and_then(|value| value.parse::<u64>().ok())
                .filter(|value| (1..=15_000).contains(value))
                .ok_or(NativeCandidateExecutionError::ModuleProbeConfiguration)?;
            Ok(Some(ModuleProbeConfiguration {
                ready_file: PathBuf::from(ready_file),
                hold: Duration::from_millis(hold_ms),
            }))
        }
        _ => Err(NativeCandidateExecutionError::ModuleProbeConfiguration),
    }
}

fn publish_module_probe_ready(
    configuration: &ModuleProbeConfiguration,
) -> Result<(), std::io::Error> {
    fs::write(&configuration.ready_file, std::process::id().to_string())?;
    std::thread::sleep(configuration.hold);
    Ok(())
}

struct PanicAfterRealPrepareBackend {
    inner: SherpaNativeBackend,
    execute_calls: Arc<AtomicUsize>,
}

impl ModelBackend for PanicAfterRealPrepareBackend {
    fn prepare(&mut self) -> Result<(), BackendFailure> {
        self.inner.prepare()
    }

    fn execute(&mut self, _action: &BackendAction) -> BackendOutcome {
        self.execute_calls.fetch_add(1, Ordering::Relaxed);
        panic!("candidate-conformance-injected-rust-panic")
    }
}

struct PrepareCountingBackend {
    inner: SherpaNativeBackend,
    prepare_calls: Arc<AtomicUsize>,
}

impl ModelBackend for PrepareCountingBackend {
    fn prepare(&mut self) -> Result<(), BackendFailure> {
        self.prepare_calls.fetch_add(1, Ordering::Relaxed);
        self.inner.prepare()
    }

    fn execute(&mut self, action: &BackendAction) -> BackendOutcome {
        self.inner.execute(action)
    }
}

fn run_stable_failure_lane(
    input: &NativeCandidateExecutionInput,
    manifest: &WorkerManifest,
    limits: WorkerLimits,
) -> Result<(), NativeCandidateExecutionError> {
    let mut invalid = input.clone();
    invalid.package_lock_path = input.schema_registry_path.clone();
    let backend = SherpaNativeBackend::new(locked_config(&invalid)?)
        .map_err(|_| NativeCandidateExecutionError::Configuration)?;
    let prepare_calls = Arc::new(AtomicUsize::new(0));
    let backend = PrepareCountingBackend {
        inner: backend,
        prepare_calls: Arc::clone(&prepare_calls),
    };
    let mut session =
        DirectWorkerSession::new(manifest.clone(), limits, backend).map_err(map_contract_error)?;
    let epoch = handshake(&mut session, manifest.clone(), limits)?;
    let prepare = global_request(
        &epoch,
        1,
        WorkerCommand::Prepare(PrepareRequest {
            model_manifest_sha256: manifest.descriptor.model_manifest_sha256,
            execution_provider: manifest.descriptor.execution_provider,
        }),
    )?;
    let first = session
        .exchange(prepare.clone())
        .map_err(map_contract_error)?;
    assert_preparation_failure(&first, "SHERPA_ASSET_MISMATCH")?;
    if session.exchange(prepare).map_err(map_contract_error)? != first
        || prepare_calls.load(Ordering::Relaxed) != 1
    {
        return Err(NativeCandidateExecutionError::Observation);
    }
    Ok(())
}

fn run_rust_panic_lane(
    input: &NativeCandidateExecutionInput,
    manifest: &WorkerManifest,
    limits: WorkerLimits,
    audio: AudioChunk,
) -> Result<(), NativeCandidateExecutionError> {
    let backend = SherpaNativeBackend::new(locked_config(input)?)
        .map_err(|_| NativeCandidateExecutionError::Configuration)?;
    let execute_calls = Arc::new(AtomicUsize::new(0));
    let backend = PanicAfterRealPrepareBackend {
        inner: backend,
        execute_calls: Arc::clone(&execute_calls),
    };
    let mut session =
        DirectWorkerSession::new(manifest.clone(), limits, backend).map_err(map_contract_error)?;
    let epoch = handshake(&mut session, manifest.clone(), limits)?;
    let prepare = global_request(
        &epoch,
        1,
        WorkerCommand::Prepare(PrepareRequest {
            model_manifest_sha256: manifest.descriptor.model_manifest_sha256,
            execution_provider: manifest.descriptor.execution_provider,
        }),
    )?;
    let prepared = session.exchange(prepare).map_err(map_contract_error)?;
    if !matches!(
        only_event(&prepared)?,
        WorkerEvent::Prepared { ready: true, .. }
    ) {
        return Err(NativeCandidateExecutionError::Observation);
    }
    let target = job("panic");
    let accepted = session
        .exchange(job_request(
            &epoch,
            2,
            &target,
            WorkerCommand::AcceptAudio(audio),
        )?)
        .map_err(map_contract_error)?;
    if !matches!(
        only_event(&accepted)?,
        WorkerEvent::AudioAccepted { sequence: 1 }
    ) {
        return Err(NativeCandidateExecutionError::Observation);
    }
    let flush = job_request(&epoch, 3, &target, WorkerCommand::FlushSegment)?;
    let failed = session
        .exchange(flush.clone())
        .map_err(map_contract_error)?;
    assert_execution_failure(&failed, "MODEL_BACKEND_PANIC", &target.segment_id)?;
    if session.exchange(flush).map_err(map_contract_error)? != failed
        || execute_calls.load(Ordering::Relaxed) != 1
    {
        return Err(NativeCandidateExecutionError::Observation);
    }
    let restart = session
        .exchange(global_request(&epoch, 4, WorkerCommand::Restart)?)
        .map_err(map_contract_error)?;
    if restart.len() != 2
        || !matches!(
            restart.first().map(WorkerResponse::event),
            Some(WorkerEvent::ReplayRequired {
                job,
                state: meetingrelay_model_worker_contract::ReplayJobState::Failure,
            }) if job == &target
        )
        || !matches!(
            restart.last().map(WorkerResponse::event),
            Some(WorkerEvent::Restarted { restart_count: 1 })
        )
    {
        return Err(NativeCandidateExecutionError::Observation);
    }
    let poisoned_prepare = session
        .exchange(global_request(
            &epoch,
            5,
            WorkerCommand::Prepare(PrepareRequest {
                model_manifest_sha256: manifest.descriptor.model_manifest_sha256,
                execution_provider: manifest.descriptor.execution_provider,
            }),
        )?)
        .map_err(map_contract_error)?;
    assert_preparation_failure(&poisoned_prepare, "MODEL_BACKEND_POISONED")?;
    if execute_calls.load(Ordering::Relaxed) != 1 {
        return Err(NativeCandidateExecutionError::Observation);
    }
    Ok(())
}

fn assert_preparation_failure(
    responses: &[WorkerResponse],
    expected_code: &str,
) -> Result<(), NativeCandidateExecutionError> {
    let WorkerEvent::PreparationFailed { error } = only_event(responses)? else {
        return Err(NativeCandidateExecutionError::Observation);
    };
    if error.code().as_str() != expected_code
        || error.retryable()
        || error.sanitized_detail().is_some()
    {
        return Err(NativeCandidateExecutionError::Observation);
    }
    Ok(())
}

fn assert_execution_failure(
    responses: &[WorkerResponse],
    expected_code: &str,
    expected_segment_id: &Identifier,
) -> Result<(), NativeCandidateExecutionError> {
    let WorkerEvent::Failure { segment_id, error } = only_event(responses)? else {
        return Err(NativeCandidateExecutionError::Observation);
    };
    if segment_id != expected_segment_id
        || error.code().as_str() != expected_code
        || error.retryable()
        || error.sanitized_detail().is_some()
    {
        return Err(NativeCandidateExecutionError::Observation);
    }
    Ok(())
}

fn only_event(responses: &[WorkerResponse]) -> Result<&WorkerEvent, NativeCandidateExecutionError> {
    let [response] = responses else {
        return Err(NativeCandidateExecutionError::Observation);
    };
    Ok(response.event())
}

fn handshake(
    session: &mut DirectWorkerSession,
    manifest: WorkerManifest,
    limits: WorkerLimits,
) -> Result<Identifier, NativeCandidateExecutionError> {
    let hello = hello_request(manifest, limits);
    let response = session
        .handshake(hello.clone())
        .map_err(map_contract_error)?;
    hello
        .validate_response(&response)
        .map_err(map_contract_error)?;
    if response.transport != TransportKind::InProcess
        || response.role != WorkerRole::NativeCandidate
    {
        return Err(NativeCandidateExecutionError::Observation);
    }
    Ok(response.delivery_session_epoch)
}

fn hello_request(manifest: WorkerManifest, limits: WorkerLimits) -> HelloRequest {
    HelloRequest {
        protocol: WORKER_PROTOCOL_V1,
        platform: Platform {
            operating_system: OperatingSystem::Windows,
            architecture: Architecture::X86_64,
        },
        core_build_sha256: manifest.executable_sha256,
        purpose: ContractPurpose::ProductShellCandidate,
        expected: manifest,
        required_capabilities: CapabilitySet::required_v1(),
        offered_limits: limits,
    }
}

fn global_request(
    epoch: &Identifier,
    sequence: u64,
    command: WorkerCommand,
) -> Result<WorkerRequest, NativeCandidateExecutionError> {
    request(epoch, sequence, None, command)
}

fn job_request(
    epoch: &Identifier,
    sequence: u64,
    job: &JobKey,
    command: WorkerCommand,
) -> Result<WorkerRequest, NativeCandidateExecutionError> {
    request(epoch, sequence, Some(job), command)
}

fn request(
    epoch: &Identifier,
    sequence: u64,
    job: Option<&JobKey>,
    command: WorkerCommand,
) -> Result<WorkerRequest, NativeCandidateExecutionError> {
    Ok(WorkerRequest {
        context: RequestContext {
            delivery_session_epoch: epoch.clone(),
            message_sequence: sequence,
            message_id: Identifier::new(&format!("candidate-native-message-{sequence}"))
                .map_err(|_| NativeCandidateExecutionError::Contract)?,
            trace_id: Identifier::new("candidate-native-conformance-trace")
                .map_err(|_| NativeCandidateExecutionError::Contract)?,
            meeting_id: job.map(|key| key.meeting_id.clone()),
            job_id: job.map(|key| key.job_id.clone()),
            segment_id: job.map(|key| key.segment_id.clone()),
            cancel_scope_id: None,
            deadline: MonotonicDeadline {
                clock_domain_id: Identifier::new("core-fixture-clock")
                    .map_err(|_| NativeCandidateExecutionError::Contract)?,
                deadline_ns: 10_000,
            },
        },
        command,
    })
}

fn locked_config(
    input: &NativeCandidateExecutionInput,
) -> Result<SherpaNativeConfig, NativeCandidateExecutionError> {
    let descriptor = locked_engine_descriptor();
    let config = SherpaNativeConfig {
        descriptor,
        model_path: input.model_path.clone(),
        expected_model_sha256: digest_from_hex(LOCKED_MODEL_SHA256_HEX)?,
        tokens_path: input.tokens_path.clone(),
        expected_tokens_sha256: digest_from_hex(LOCKED_TOKENS_SHA256_HEX)?,
        runtime_lib_dir: input.runtime_lib_dir.clone(),
        expected_runtime_sha256: digest_from_hex(LOCKED_RUNTIME_BUNDLE_SHA256_HEX)?,
        asset_lock_path: input.asset_lock_path.clone(),
        expected_asset_lock_sha256: digest_from_hex(LOCKED_ASSET_LOCK_SHA256_HEX)?,
        package_lock_path: input.package_lock_path.clone(),
        expected_package_lock_sha256: digest_from_hex(LOCKED_PACKAGE_LOCK_SHA256_HEX)?,
        normalized_language: LanguageCode::new("zh")
            .map_err(|_| NativeCandidateExecutionError::Configuration)?,
        execution_provider: ExecutionProvider::Cpu,
        num_threads: 1,
        use_itn: true,
        max_input_bytes: 64 * 1024 * 1024,
    };
    if config.descriptor.parameter_sha256 != digest_from_hex(LOCKED_PARAMETER_SHA256_HEX)? {
        return Err(NativeCandidateExecutionError::Configuration);
    }
    config
        .validate()
        .map_err(|_| NativeCandidateExecutionError::Configuration)?;
    Ok(config)
}

fn validate_absolute_inputs(
    input: &NativeCandidateExecutionInput,
) -> Result<(), NativeCandidateExecutionError> {
    let paths = [
        &input.executable_path,
        &input.schema_registry_path,
        &input.model_path,
        &input.tokens_path,
        &input.runtime_lib_dir,
        &input.asset_lock_path,
        &input.package_lock_path,
        &input.wav_path,
    ];
    if paths.iter().any(|path| !path.is_absolute()) {
        return Err(NativeCandidateExecutionError::InvalidInput);
    }
    Ok(())
}

fn split_conformance_audio(
    samples: &[i16],
) -> Result<(AudioChunk, AudioGap, AudioChunk), NativeCandidateExecutionError> {
    if samples.len() < 2 {
        return Err(NativeCandidateExecutionError::InvalidInput);
    }
    let split = samples.len() / 2;
    let first = audio_chunk(1, 0, 0, &samples[..split])?;
    let gap = AudioGap {
        sequence: 2,
        media_start_sample: first.media_end_sample,
        media_end_sample: first
            .media_end_sample
            .checked_add(320)
            .ok_or(NativeCandidateExecutionError::InvalidInput)?,
        reason: GapReason::CaptureDiscontinuity,
    };
    let second = audio_chunk(
        3,
        gap.media_end_sample,
        u64::try_from(split).map_err(|_| NativeCandidateExecutionError::InvalidInput)?,
        &samples[split..],
    )?;
    Ok((first, gap, second))
}

fn audio_chunk(
    sequence: u64,
    media_start_sample: u64,
    device_start_sample: u64,
    samples: &[i16],
) -> Result<AudioChunk, NativeCandidateExecutionError> {
    if samples.is_empty() {
        return Err(NativeCandidateExecutionError::InvalidInput);
    }
    let sample_count =
        u64::try_from(samples.len()).map_err(|_| NativeCandidateExecutionError::InvalidInput)?;
    let media_end_sample = media_start_sample
        .checked_add(sample_count)
        .ok_or(NativeCandidateExecutionError::InvalidInput)?;
    let device_end_sample = device_start_sample
        .checked_add(sample_count)
        .ok_or(NativeCandidateExecutionError::InvalidInput)?;
    let payload_bytes = sample_count
        .checked_mul(2)
        .ok_or(NativeCandidateExecutionError::InvalidInput)?;
    let mut hasher = Sha256::new();
    for sample in samples {
        hasher.update(sample.to_le_bytes());
    }
    let capture_epoch_id = Identifier::new("candidate-native-capture-epoch")
        .map_err(|_| NativeCandidateExecutionError::Contract)?;
    Ok(AudioChunk {
        sequence,
        media_start_sample,
        media_end_sample,
        timeline_rate: 16_000,
        format: AudioFormat {
            sample_rate_hz: 16_000,
            channels: 1,
            sample_format: SampleFormat::PcmS16Le,
        },
        capture_epoch_ids: vec![capture_epoch_id.clone()],
        source_ranges: vec![SourceRange {
            audio_source: AudioSource::System,
            capture_epoch_id,
            device_start_sample,
            device_end_sample,
            meeting_start_sample: media_start_sample,
            meeting_end_sample: media_end_sample,
            sample_rate_hz: 16_000,
        }],
        payload_bytes,
        payload_sha256: Some(Sha256Digest::from_bytes(hasher.finalize().into())),
        payload: Some(AudioPayload::PcmS16Le(Arc::from(samples))),
    })
}

fn read_verified_mono_pcm16_wav(
    path: &Path,
    expected_size_bytes: u64,
    expected_sha256: Sha256Digest,
) -> Result<(Vec<i16>, Sha256Digest), NativeCandidateExecutionError> {
    let path_metadata =
        fs::symlink_metadata(path).map_err(|_| NativeCandidateExecutionError::AssetUnavailable)?;
    if !is_regular_non_reparse_file(&path_metadata) || path_metadata.len() != expected_size_bytes {
        return Err(NativeCandidateExecutionError::AssetMismatch);
    }
    let file = fs::File::open(path).map_err(|_| NativeCandidateExecutionError::AssetUnavailable)?;
    let opened_metadata = file
        .metadata()
        .map_err(|_| NativeCandidateExecutionError::AssetUnavailable)?;
    if !opened_metadata.is_file() || opened_metadata.len() != expected_size_bytes {
        return Err(NativeCandidateExecutionError::AssetMismatch);
    }
    let capacity = usize::try_from(expected_size_bytes)
        .map_err(|_| NativeCandidateExecutionError::InvalidInput)?;
    let read_limit = expected_size_bytes
        .checked_add(1)
        .ok_or(NativeCandidateExecutionError::InvalidInput)?;
    let mut bytes = Vec::with_capacity(capacity);
    file.take(read_limit)
        .read_to_end(&mut bytes)
        .map_err(|_| NativeCandidateExecutionError::AssetUnavailable)?;
    if bytes.len() != capacity {
        return Err(NativeCandidateExecutionError::AssetMismatch);
    }
    let actual_sha256 = Sha256Digest::from_bytes(Sha256::digest(&bytes).into());
    if actual_sha256 != expected_sha256 {
        return Err(NativeCandidateExecutionError::AssetMismatch);
    }
    let samples = parse_mono_pcm16_wav(&bytes)?;
    Ok((samples, actual_sha256))
}

fn parse_mono_pcm16_wav(bytes: &[u8]) -> Result<Vec<i16>, NativeCandidateExecutionError> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(NativeCandidateExecutionError::AssetMismatch);
    }
    let mut offset = 12_usize;
    let mut format = None;
    let mut data = None;
    while offset
        .checked_add(8)
        .is_some_and(|chunk_header_end| chunk_header_end <= bytes.len())
    {
        let size = read_u32(bytes, offset + 4)? as usize;
        let start = offset
            .checked_add(8)
            .ok_or(NativeCandidateExecutionError::AssetMismatch)?;
        let end = start
            .checked_add(size)
            .ok_or(NativeCandidateExecutionError::AssetMismatch)?;
        if end > bytes.len() {
            return Err(NativeCandidateExecutionError::AssetMismatch);
        }
        if &bytes[offset..offset + 4] == b"fmt " {
            if size < 16 {
                return Err(NativeCandidateExecutionError::AssetMismatch);
            }
            format = Some((
                read_u16(bytes, start)?,
                read_u16(bytes, start + 2)?,
                read_u32(bytes, start + 4)?,
                read_u16(bytes, start + 14)?,
            ));
        } else if &bytes[offset..offset + 4] == b"data" {
            data = Some(&bytes[start..end]);
        }
        offset = end
            .checked_add(size & 1)
            .ok_or(NativeCandidateExecutionError::AssetMismatch)?;
    }
    if format != Some((1, 1, 16_000, 16)) {
        return Err(NativeCandidateExecutionError::AssetMismatch);
    }
    let data = data.ok_or(NativeCandidateExecutionError::AssetMismatch)?;
    if data.is_empty() || data.len() % 2 != 0 {
        return Err(NativeCandidateExecutionError::AssetMismatch);
    }
    Ok(data
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect())
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, NativeCandidateExecutionError> {
    let end = offset
        .checked_add(2)
        .ok_or(NativeCandidateExecutionError::AssetMismatch)?;
    let pair = bytes
        .get(offset..end)
        .ok_or(NativeCandidateExecutionError::AssetMismatch)?;
    Ok(u16::from_le_bytes([pair[0], pair[1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, NativeCandidateExecutionError> {
    let end = offset
        .checked_add(4)
        .ok_or(NativeCandidateExecutionError::AssetMismatch)?;
    let value = bytes
        .get(offset..end)
        .ok_or(NativeCandidateExecutionError::AssetMismatch)?;
    Ok(u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
}

fn conformance_limits() -> WorkerLimits {
    WorkerLimits {
        max_control_message_bytes: 1_048_576,
        max_audio_chunk_bytes: 4_194_304,
        max_pending_audio_bytes: 16_777_216,
        max_capture_epochs_per_chunk: 8,
        max_source_ranges_per_chunk: 32,
        max_in_flight_jobs: 8,
        max_tracked_jobs: 64,
        max_retired_job_keys: 128,
        max_pending_commands: 2,
        max_pending_deliveries: 16,
        max_pending_progress_per_job: 8,
        max_fallback_nodes: 8,
        max_replay_events_per_batch: 8,
        max_cancel_jobs_per_batch: 4,
        max_cancellation_scopes: 64,
        max_replay_entries: 128,
        heartbeat_interval_ms: 1_000,
    }
}

fn validate_loaded_runtime_identity(
    executable_path: &Path,
) -> Result<(), NativeCandidateExecutionError> {
    let executable_directory = executable_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or(NativeCandidateExecutionError::Provenance)?;
    validate_staged_runtime_dlls(executable_directory)?;
    validate_process_runtime_modules(executable_directory)?;
    // Re-read the locked staging identities after the process-module query so
    // the record cannot rely on a stale pre-query file observation.
    validate_staged_runtime_dlls(executable_directory)
}

fn validate_staged_runtime_dlls(
    executable_directory: &Path,
) -> Result<(), NativeCandidateExecutionError> {
    let mut validated = 0_usize;
    for asset in RUNTIME_ASSETS
        .iter()
        .filter(|asset| asset.name.ends_with(".dll"))
    {
        validate_runtime_asset(executable_directory, asset)?;
        validated = validated
            .checked_add(1)
            .ok_or(NativeCandidateExecutionError::Provenance)?;
    }
    if validated != LOCKED_STAGED_RUNTIME_DLL_COUNT {
        return Err(NativeCandidateExecutionError::Provenance);
    }
    Ok(())
}

fn validate_runtime_asset(
    directory: &Path,
    asset: &RuntimeAsset,
) -> Result<(), NativeCandidateExecutionError> {
    let path = directory.join(asset.name);
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| NativeCandidateExecutionError::Provenance)?;
    if !is_regular_non_reparse_file(&metadata) || metadata.len() != asset.size_bytes {
        return Err(NativeCandidateExecutionError::Provenance);
    }
    let expected = digest_from_hex(asset.sha256)?;
    if sha256_file(&path).map_err(|_| NativeCandidateExecutionError::Provenance)? != expected {
        return Err(NativeCandidateExecutionError::Provenance);
    }
    Ok(())
}

fn is_regular_non_reparse_file(metadata: &fs::Metadata) -> bool {
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
    }
    #[cfg(not(windows))]
    {
        true
    }
}

#[cfg(windows)]
fn validate_process_runtime_modules(
    executable_directory: &Path,
) -> Result<(), NativeCandidateExecutionError> {
    let powershell = system_powershell_path()?;
    let sherpa_sha256 = locked_runtime_asset(REQUIRED_LOADED_RUNTIME_MODULES[0])?.sha256;
    let onnx_sha256 = locked_runtime_asset(REQUIRED_LOADED_RUNTIME_MODULES[1])?.sha256;
    let output = Command::new(powershell)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            LOADED_RUNTIME_IDENTITY_SCRIPT,
        ])
        .env(
            "MEETINGRELAY_RUNTIME_IDENTITY_PROCESS_ID",
            std::process::id().to_string(),
        )
        .env(
            "MEETINGRELAY_RUNTIME_IDENTITY_EXECUTABLE_DIRECTORY",
            executable_directory,
        )
        .env("MEETINGRELAY_RUNTIME_IDENTITY_SHERPA_SHA256", sherpa_sha256)
        .env("MEETINGRELAY_RUNTIME_IDENTITY_ONNX_SHA256", onnx_sha256)
        .output()
        .map_err(|_| NativeCandidateExecutionError::Provenance)?;
    if !output.status.success() || !output.stdout.is_empty() || !output.stderr.is_empty() {
        return Err(NativeCandidateExecutionError::Provenance);
    }
    Ok(())
}

#[cfg(not(windows))]
fn validate_process_runtime_modules(
    _executable_directory: &Path,
) -> Result<(), NativeCandidateExecutionError> {
    Err(NativeCandidateExecutionError::Provenance)
}

#[cfg(windows)]
fn system_powershell_path() -> Result<PathBuf, NativeCandidateExecutionError> {
    let system_root = std::env::var_os("SystemRoot")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or(NativeCandidateExecutionError::Provenance)?;
    let powershell = system_root.join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let metadata =
        fs::symlink_metadata(&powershell).map_err(|_| NativeCandidateExecutionError::Provenance)?;
    if !is_regular_non_reparse_file(&metadata) {
        return Err(NativeCandidateExecutionError::Provenance);
    }
    Ok(powershell)
}

fn locked_runtime_asset(
    name: &str,
) -> Result<&'static RuntimeAsset, NativeCandidateExecutionError> {
    RUNTIME_ASSETS
        .iter()
        .find(|asset| asset.name.eq_ignore_ascii_case(name))
        .ok_or(NativeCandidateExecutionError::Provenance)
}

#[cfg(windows)]
const LOADED_RUNTIME_IDENTITY_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$processId = [int][Environment]::GetEnvironmentVariable('MEETINGRELAY_RUNTIME_IDENTITY_PROCESS_ID')
$directory = [IO.Path]::GetFullPath([Environment]::GetEnvironmentVariable('MEETINGRELAY_RUNTIME_IDENTITY_EXECUTABLE_DIRECTORY'))
$expectedHashes = @{
    'sherpa-onnx-c-api.dll' = [Environment]::GetEnvironmentVariable('MEETINGRELAY_RUNTIME_IDENTITY_SHERPA_SHA256')
    'onnxruntime.dll' = [Environment]::GetEnvironmentVariable('MEETINGRELAY_RUNTIME_IDENTITY_ONNX_SHA256')
}
$modules = @([Diagnostics.Process]::GetProcessById($processId).Modules)
foreach ($name in @('sherpa-onnx-c-api.dll', 'onnxruntime.dll')) {
    $match = $null
    $matchCount = 0
    foreach ($module in $modules) {
        if ([string]::Equals($module.ModuleName, $name, [StringComparison]::OrdinalIgnoreCase)) {
            $match = $module
            $matchCount += 1
        }
    }
    if ($matchCount -ne 1) { exit 21 }
    $expectedPath = [IO.Path]::GetFullPath([IO.Path]::Combine($directory, $name))
    $actualPath = [IO.Path]::GetFullPath($match.FileName)
    if (-not $actualPath.Equals($expectedPath, [StringComparison]::OrdinalIgnoreCase)) { exit 22 }
    $stream = [IO.File]::OpenRead($actualPath)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $actualHash = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '')
    }
    finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
    if (-not $actualHash.Equals($expectedHashes[$name], [StringComparison]::OrdinalIgnoreCase)) { exit 23 }
}
"#;

fn encode_record(
    manifest: &WorkerManifest,
    final_transcript_sha256: Sha256Digest,
    final_transcript_utf8_bytes: usize,
    wav_sha256: Sha256Digest,
) -> Result<Vec<u8>, NativeCandidateExecutionError> {
    if manifest.role != WorkerRole::NativeCandidate
        || manifest.descriptor.parameter_sha256 != digest_from_hex(LOCKED_PARAMETER_SHA256_HEX)?
    {
        return Err(NativeCandidateExecutionError::Provenance);
    }
    let executable = manifest.executable_sha256.to_lower_hex();
    let schema = manifest.schema_registry_sha256.to_lower_hex();
    let mut output = String::with_capacity(2_048);
    output.push_str("{\"authority\":{\"formal_claims\":\"none\",\"production_evidence\":false},");
    output.push_str(concat!(
        "\"checks\":{\"bounded_audio_gap\":true,",
        "\"bounded_credit_backpressure\":true,\"cancellation\":true,",
        "\"final_and_replay\":true,\"handshake_manifest\":true,",
        "\"heartbeat_progress\":true,\"loaded_runtime_identity\":true,",
        "\"prepare\":true,\"provenance_join\":true,",
        "\"restart_replay\":true,\"rust_panic_containment\":true,",
        "\"stable_failure\":true},\"execution\":{\"actual_native_inference\":true,",
        "\"backend_execute_calls\":1,\"final_transcript_sha256\":\""
    ));
    output.push_str(&final_transcript_sha256.to_lower_hex());
    output.push_str("\",\"final_transcript_utf8_bytes\":");
    output.push_str(&final_transcript_utf8_bytes.to_string());
    output.push_str(",\"fixture_wav_sha256\":\"");
    output.push_str(&wav_sha256.to_lower_hex());
    output.push_str(concat!(
        "\",\"outer_process_boundary\":\"crash-containment-only\",",
        "\"resource_performance_measurement\":\"unmeasured\",",
        "\"semantic_transport\":\"in-process\"},",
        "\"kind\":\"meetingrelay-native-candidate-conformance-v1\",",
        "\"limitations\":[\"native-process-abort-isolation-not-tested\",",
        "\"onsite-quality-performance-not-measured\",",
        "\"resource-usage-not-measured\"],\"schema_version\":\"1.0\",",
        "\"worker_manifest\":{\"descriptor\":"
    ));
    push_descriptor_json(&mut output, &manifest.descriptor);
    output.push_str(",\"executable_sha256\":\"");
    output.push_str(&executable);
    output.push_str("\",\"role\":\"native-candidate\",\"schema_registry_sha256\":\"");
    output.push_str(&schema);
    output.push_str("\",\"worker_build_sha256\":\"");
    output.push_str(&executable);
    output.push_str("\",\"worker_id\":\"");
    output.push_str(manifest.worker_id.as_str());
    output.push_str("\"}}\n");
    Ok(output.into_bytes())
}

fn digest_from_hex(value: &str) -> Result<Sha256Digest, NativeCandidateExecutionError> {
    Sha256Digest::from_lower_hex(value).map_err(|_| NativeCandidateExecutionError::Provenance)
}

fn map_contract_error(_error: ContractError) -> NativeCandidateExecutionError {
    NativeCandidateExecutionError::Contract
}

fn map_conformance_error(_error: CandidateConformanceError) -> NativeCandidateExecutionError {
    NativeCandidateExecutionError::Observation
}

fn map_provenance_error(_error: WorkerProvenanceError) -> NativeCandidateExecutionError {
    NativeCandidateExecutionError::Provenance
}

fn job(label: &str) -> JobKey {
    JobKey {
        meeting_id: Identifier::new("candidate-native-meeting")
            .expect("constant meeting identifier is valid"),
        job_id: Identifier::new(&format!("candidate-native-job-{label}"))
            .expect("bounded label forms a valid job identifier"),
        segment_id: Identifier::new(&format!("candidate-native-segment-{label}"))
            .expect("bounded label forms a valid segment identifier"),
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    #[cfg(feature = "native-fault-fixture")]
    use std::sync::Mutex;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use super::*;

    const ONE_BYTE_RUNTIME_ASSET: RuntimeAsset = RuntimeAsset {
        name: "fixture-runtime.dll",
        size_bytes: 1,
        sha256: "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
    };

    #[cfg(feature = "native-fault-fixture")]
    struct RecordingCheckpointObserver {
        checkpoints: Arc<Mutex<Vec<NativeCandidateCheckpoint>>>,
    }

    #[cfg(feature = "native-fault-fixture")]
    impl NativeCandidateCheckpointObserver for RecordingCheckpointObserver {
        fn observe(
            &self,
            checkpoint: NativeCandidateCheckpoint,
        ) -> Result<(), NativeCandidateExecutionError> {
            self.checkpoints
                .lock()
                .expect("checkpoint fixture lock")
                .push(checkpoint);
            Ok(())
        }
    }

    #[test]
    #[cfg(feature = "native-fault-fixture")]
    fn checkpoint_observer_receives_prepare_then_successful_inference() {
        let checkpoints = Arc::new(Mutex::new(Vec::new()));
        let observer: CheckpointObserver = Arc::new(RecordingCheckpointObserver {
            checkpoints: Arc::clone(&checkpoints),
        });

        observe_checkpoint(
            Some(&observer),
            NativeCandidateCheckpoint::RealPrepareLoadedRuntimeIdentity,
        )
        .expect("observe real prepare");
        observe_checkpoint(
            Some(&observer),
            NativeCandidateCheckpoint::SuccessfulRealInference {
                backend_execute_calls: 1,
            },
        )
        .expect("observe successful inference");

        assert_eq!(
            *checkpoints.lock().expect("checkpoint fixture lock"),
            [
                NativeCandidateCheckpoint::RealPrepareLoadedRuntimeIdentity,
                NativeCandidateCheckpoint::SuccessfulRealInference {
                    backend_execute_calls: 1,
                },
            ]
        );
    }

    #[test]
    #[cfg(feature = "native-fault-fixture")]
    fn absent_checkpoint_observer_preserves_normal_execution_path() {
        assert_eq!(
            observe_checkpoint(
                None,
                NativeCandidateCheckpoint::RealPrepareLoadedRuntimeIdentity,
            ),
            Ok(())
        );
        assert_eq!(
            observe_checkpoint(
                None,
                NativeCandidateCheckpoint::SuccessfulRealInference {
                    backend_execute_calls: 1,
                },
            ),
            Ok(())
        );
    }

    #[test]
    fn module_probe_configuration_is_bounded_and_fail_closed() {
        assert_eq!(module_probe_configuration(None, None), Ok(None));

        for (ready_file, hold_ms) in [
            (Some(OsString::from("ready")), None),
            (None, Some(OsString::from("1"))),
            (Some(OsString::new()), Some(OsString::from("1"))),
            (Some(OsString::from("ready")), Some(OsString::new())),
            (Some(OsString::from("ready")), Some(OsString::from("0"))),
            (Some(OsString::from("ready")), Some(OsString::from("15001"))),
            (
                Some(OsString::from("ready")),
                Some(OsString::from("not-a-number")),
            ),
        ] {
            assert_eq!(
                module_probe_configuration(ready_file, hold_ms),
                Err(NativeCandidateExecutionError::ModuleProbeConfiguration)
            );
        }

        let configuration = module_probe_configuration(
            Some(OsString::from("ready")),
            Some(OsString::from("15000")),
        )
        .expect("maximum bounded probe hold is valid")
        .expect("configured probe is present");
        assert_eq!(configuration.ready_file, PathBuf::from("ready"));
        assert_eq!(configuration.hold, Duration::from_millis(15_000));
    }

    #[test]
    fn module_probe_publishes_only_the_current_pid() {
        let directory = unique_test_directory("module-probe");
        fs::create_dir_all(&directory).expect("create module-probe fixture directory");
        let ready_file = directory.join("ready.pid");
        let configuration = ModuleProbeConfiguration {
            ready_file: ready_file.clone(),
            hold: Duration::from_millis(1),
        };

        publish_module_probe_ready(&configuration).expect("publish module-probe PID");

        assert_eq!(
            fs::read_to_string(&ready_file).expect("read module-probe PID"),
            std::process::id().to_string()
        );
        fs::remove_dir_all(directory).expect("remove module-probe fixture directory");
    }

    #[test]
    fn staged_runtime_asset_requires_locked_size_and_digest() {
        let directory = unique_test_directory("runtime-asset");
        fs::create_dir_all(&directory).expect("create runtime fixture directory");
        let path = directory.join(ONE_BYTE_RUNTIME_ASSET.name);
        fs::write(&path, b"a").expect("write matching runtime fixture");
        assert_eq!(
            validate_runtime_asset(&directory, &ONE_BYTE_RUNTIME_ASSET),
            Ok(())
        );

        fs::write(&path, b"b").expect("tamper runtime fixture");
        assert_eq!(
            validate_runtime_asset(&directory, &ONE_BYTE_RUNTIME_ASSET),
            Err(NativeCandidateExecutionError::Provenance)
        );
        fs::remove_dir_all(directory).expect("remove runtime fixture directory");
    }

    #[test]
    fn wav_digest_and_pcm_parse_share_one_bounded_file_read() {
        let directory = unique_test_directory("conformance-wav");
        fs::create_dir_all(&directory).expect("create WAV fixture directory");
        let path = directory.join("fixture.wav");
        let original_samples = [1_i16, -2, 3, -4];
        let replacement_samples = [9_i16, 8, 7, 6];
        let original = mono_pcm16_wav(&original_samples);
        let replacement = mono_pcm16_wav(&replacement_samples);
        assert_eq!(original.len(), replacement.len());
        let expected_sha256 = Sha256Digest::from_bytes(Sha256::digest(&original).into());
        fs::write(&path, &original).expect("write original WAV fixture");

        let (decoded, actual_sha256) = read_verified_mono_pcm16_wav(
            &path,
            u64::try_from(original.len()).expect("fixture size fits u64"),
            expected_sha256,
        )
        .expect("read, hash, and parse one locked byte buffer");
        fs::write(&path, &replacement).expect("replace WAV after the verified read");

        assert_eq!(decoded, original_samples);
        assert_eq!(actual_sha256, expected_sha256);
        assert_eq!(
            read_verified_mono_pcm16_wav(
                &path,
                u64::try_from(original.len()).expect("fixture size fits u64"),
                expected_sha256,
            ),
            Err(NativeCandidateExecutionError::AssetMismatch)
        );
        fs::remove_dir_all(directory).expect("remove WAV fixture directory");
    }

    #[test]
    fn locked_runtime_inventory_has_four_staged_dlls_and_required_loaded_modules() {
        assert_eq!(
            RUNTIME_ASSETS
                .iter()
                .filter(|asset| asset.name.ends_with(".dll"))
                .count(),
            LOCKED_STAGED_RUNTIME_DLL_COUNT
        );
        for name in REQUIRED_LOADED_RUNTIME_MODULES {
            assert!(locked_runtime_asset(name).is_ok());
        }
    }

    #[test]
    fn canonical_record_marks_loaded_runtime_identity() {
        let digest = Sha256Digest::from_bytes([7; 32]);
        let manifest = locked_worker_manifest(digest, digest).expect("construct locked manifest");
        let record = encode_record(&manifest, digest, 1, digest).expect("encode record");
        let record = std::str::from_utf8(&record).expect("record is UTF-8");

        assert!(record.contains("\"loaded_runtime_identity\":true"));
    }

    fn mono_pcm16_wav(samples: &[i16]) -> Vec<u8> {
        let data_size = u32::try_from(samples.len() * 2).expect("fixture data size fits u32");
        let mut bytes = Vec::with_capacity(44 + data_size as usize);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_size).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16_u32.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&16_000_u32.to_le_bytes());
        bytes.extend_from_slice(&32_000_u32.to_le_bytes());
        bytes.extend_from_slice(&2_u16.to_le_bytes());
        bytes.extend_from_slice(&16_u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_size.to_le_bytes());
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        bytes
    }

    fn unique_test_directory(label: &str) -> PathBuf {
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
