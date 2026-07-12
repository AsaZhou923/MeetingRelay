#![cfg(feature = "native-sherpa")]

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use meetingrelay_model_worker_contract::{
    Architecture, AudioChunk, AudioFormat, AudioPayload, AudioSource, BackendAction,
    BackendOutcome, CapabilitySet, ContractPurpose, DirectWorkerSession, EngineDescriptor,
    ExecutionProvider, HelloRequest, Identifier, JobKey, LanguageCode, ModelBackend,
    MonotonicDeadline, OperatingSystem, Platform, PrepareRequest, RequestContext, SampleFormat,
    Sha256Digest, SourceRange, TransportKind, WORKER_PROTOCOL_V1, WorkerCommand, WorkerEndpoint,
    WorkerEvent, WorkerLimits, WorkerManifest, WorkerRequest, WorkerRole,
};
use meetingrelay_model_worker_sherpa_native::{
    LOCKED_ASSET_LOCK_SHA256_HEX, LOCKED_MODEL_SHA256_HEX, LOCKED_RUNTIME_BUNDLE_SHA256_HEX,
    LOCKED_TOKENS_SHA256_HEX, SherpaNativeBackend, SherpaNativeConfig, locked_engine_descriptor,
    sha256_file,
};
use sha2::{Digest, Sha256};

const SAMPLE_RATE_HZ: u32 = 16_000;
const SMOKE_WAV_SHA256: &str = "b77f1794fe374a0ba1ee1dc458bfaf9349496cbbfc32780c50ba3c5a7ad8e373";

struct CountingBackend {
    inner: SherpaNativeBackend,
    calls: Arc<AtomicUsize>,
}

impl ModelBackend for CountingBackend {
    fn prepare(&mut self) -> Result<(), meetingrelay_model_worker_contract::BackendFailure> {
        self.inner.prepare()
    }

    fn execute(&mut self, action: &BackendAction) -> BackendOutcome {
        self.calls.fetch_add(1, Ordering::Relaxed);
        self.inner.execute(action)
    }
}

#[test]
#[ignore = "requires explicitly provisioned sherpa runtime, SenseVoice model, tokens, and WAV"]
fn native_sense_voice_smoke_returns_nonempty_final() {
    let model_path = required_path("MEETINGRELAY_SHERPA_MODEL");
    let tokens_path = required_path("MEETINGRELAY_SHERPA_TOKENS");
    let wav_path = required_path("MEETINGRELAY_SHERPA_WAV");
    let lock_path = required_path("MEETINGRELAY_SHERPA_LOCK");
    let runtime_lib_dir = required_path("SHERPA_ONNX_LIB_DIR");
    let package_lock_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../Cargo.lock");
    let model_sha256 = locked_file_digest(&model_path, LOCKED_MODEL_SHA256_HEX, "model");
    let tokens_sha256 = locked_file_digest(&tokens_path, LOCKED_TOKENS_SHA256_HEX, "tokens");
    let model_manifest_sha256 =
        locked_file_digest(&lock_path, LOCKED_ASSET_LOCK_SHA256_HEX, "asset lock");
    let package_lock_sha256 = sha256_file(&package_lock_path).expect("hash workspace Cargo.lock");
    let runtime_sha256 = digest_from_hex(LOCKED_RUNTIME_BUNDLE_SHA256_HEX);
    assert_eq!(
        locked_file_digest(&wav_path, SMOKE_WAV_SHA256, "smoke WAV"),
        digest_from_hex(SMOKE_WAV_SHA256)
    );
    let samples = read_mono_pcm16_wav(&wav_path);
    let descriptor = descriptor(
        model_sha256,
        model_manifest_sha256,
        package_lock_sha256,
        runtime_sha256,
    );
    let config = SherpaNativeConfig {
        descriptor: descriptor.clone(),
        model_path,
        expected_model_sha256: model_sha256,
        tokens_path,
        expected_tokens_sha256: tokens_sha256,
        runtime_lib_dir,
        expected_runtime_sha256: runtime_sha256,
        asset_lock_path: lock_path,
        expected_asset_lock_sha256: model_manifest_sha256,
        package_lock_path,
        expected_package_lock_sha256: package_lock_sha256,
        normalized_language: language("zh"),
        execution_provider: ExecutionProvider::Cpu,
        num_threads: 1,
        use_itn: true,
        max_input_bytes: 64 * 1024 * 1024,
    };
    let backend = SherpaNativeBackend::new(config).expect("valid sherpa backend config");
    let backend_calls = Arc::new(AtomicUsize::new(0));
    let backend = CountingBackend {
        inner: backend,
        calls: Arc::clone(&backend_calls),
    };
    let manifest = manifest(descriptor.clone());
    let limits = limits();
    let mut session = DirectWorkerSession::new(manifest.clone(), limits, backend)
        .expect("construct direct native session");
    let hello = session
        .handshake(HelloRequest {
            protocol: WORKER_PROTOCOL_V1,
            platform: Platform {
                operating_system: OperatingSystem::Windows,
                architecture: Architecture::X86_64,
            },
            core_build_sha256: digest(20),
            purpose: ContractPurpose::ProductShellCandidate,
            expected: manifest,
            required_capabilities: CapabilitySet::required_v1(),
            offered_limits: limits,
        })
        .expect("handshake native session");
    assert_eq!(hello.transport, TransportKind::InProcess);

    let job = JobKey {
        meeting_id: id("native-smoke-meeting"),
        job_id: id("native-smoke-job"),
        segment_id: id("native-smoke-segment"),
    };
    let prepared = exchange(
        &mut session,
        request(
            &hello.delivery_session_epoch,
            1,
            None,
            WorkerCommand::Prepare(PrepareRequest {
                model_manifest_sha256: descriptor.model_manifest_sha256,
                execution_provider: ExecutionProvider::Cpu,
            }),
        ),
    );
    let [prepared_response] = prepared.as_slice() else {
        panic!("native prepare must return exactly one response");
    };
    assert!(matches!(
        prepared_response.event(),
        WorkerEvent::Prepared { ready: true, .. }
    ));
    hold_for_loaded_module_probe();
    exchange(
        &mut session,
        request(
            &hello.delivery_session_epoch,
            2,
            Some(&job),
            WorkerCommand::AcceptAudio(audio_chunk(samples)),
        ),
    );
    let flush = request(
        &hello.delivery_session_epoch,
        3,
        Some(&job),
        WorkerCommand::FlushSegment,
    );
    let final_responses = exchange(&mut session, flush.clone());
    assert_eq!(backend_calls.load(Ordering::Relaxed), 1);

    let [response] = final_responses.as_slice() else {
        panic!("native smoke must return exactly one terminal response");
    };
    let WorkerEvent::Final { result, .. } = response.event() else {
        panic!("native smoke must return a final result");
    };
    let transcript_bytes = result.original_transcript.as_str().trim().len();
    assert!(
        transcript_bytes > 0,
        "native smoke transcript must be nonempty"
    );
    let replay = exchange(&mut session, flush);
    assert_eq!(replay, final_responses);
    assert_eq!(backend_calls.load(Ordering::Relaxed), 1);
    eprintln!("SHERPA_SMOKE_NONEMPTY_TRANSCRIPT_BYTES={transcript_bytes}");
    eprintln!("SHERPA_SMOKE_BACKEND_CALLS=1");
}

fn locked_file_digest(path: &Path, expected: &str, label: &str) -> Sha256Digest {
    let expected = digest_from_hex(expected);
    let actual = sha256_file(path).unwrap_or_else(|_| panic!("hash locked {label}"));
    assert_eq!(actual, expected, "{label} differs from the committed lock");
    actual
}

fn digest_from_hex(value: &str) -> Sha256Digest {
    Sha256Digest::from_lower_hex(value).expect("locked SHA-256 is valid")
}

fn required_path(name: &str) -> PathBuf {
    PathBuf::from(env::var_os(name).unwrap_or_else(|| panic!("{name} must be set")))
}

fn exchange(
    session: &mut DirectWorkerSession,
    request: WorkerRequest,
) -> Vec<meetingrelay_model_worker_contract::WorkerResponse> {
    session.exchange(request).expect("native session exchange")
}

fn request(
    delivery_session_epoch: &Identifier,
    message_sequence: u64,
    job: Option<&JobKey>,
    command: WorkerCommand,
) -> WorkerRequest {
    WorkerRequest {
        context: RequestContext {
            delivery_session_epoch: delivery_session_epoch.clone(),
            message_sequence,
            message_id: id(&format!("native-smoke-message-{message_sequence}")),
            trace_id: id("native-smoke-trace"),
            meeting_id: job.map(|key| key.meeting_id.clone()),
            job_id: job.map(|key| key.job_id.clone()),
            segment_id: job.map(|key| key.segment_id.clone()),
            cancel_scope_id: None,
            deadline: MonotonicDeadline {
                clock_domain_id: id("core-fixture-clock"),
                deadline_ns: 10_000,
            },
        },
        command,
    }
}

fn audio_chunk(samples: Vec<i16>) -> AudioChunk {
    assert!(!samples.is_empty());
    let sample_count = u64::try_from(samples.len()).expect("WAV sample count fits u64");
    let payload_bytes = sample_count
        .checked_mul(2)
        .expect("WAV byte count fits u64");
    let mut hasher = Sha256::new();
    for sample in &samples {
        hasher.update(sample.to_le_bytes());
    }
    let payload_sha256 = Sha256Digest::from_bytes(hasher.finalize().into());
    let capture_epoch_id = id("native-smoke-capture-epoch");
    AudioChunk {
        sequence: 1,
        media_start_sample: 0,
        media_end_sample: sample_count,
        timeline_rate: SAMPLE_RATE_HZ,
        format: AudioFormat {
            sample_rate_hz: SAMPLE_RATE_HZ,
            channels: 1,
            sample_format: SampleFormat::PcmS16Le,
        },
        capture_epoch_ids: vec![capture_epoch_id.clone()],
        source_ranges: vec![SourceRange {
            audio_source: AudioSource::System,
            capture_epoch_id,
            device_start_sample: 0,
            device_end_sample: sample_count,
            meeting_start_sample: 0,
            meeting_end_sample: sample_count,
            sample_rate_hz: SAMPLE_RATE_HZ,
        }],
        payload_bytes,
        payload_sha256: Some(payload_sha256),
        payload: Some(AudioPayload::PcmS16Le(Arc::from(samples))),
    }
}

fn descriptor(
    model_sha256: Sha256Digest,
    model_manifest_sha256: Sha256Digest,
    package_lock_sha256: Sha256Digest,
    runtime_sha256: Sha256Digest,
) -> EngineDescriptor {
    let descriptor = locked_engine_descriptor();
    assert_eq!(descriptor.model_sha256, model_sha256);
    assert_eq!(descriptor.model_manifest_sha256, model_manifest_sha256);
    assert_eq!(descriptor.package_lock_sha256, package_lock_sha256);
    assert_eq!(descriptor.runtime_sha256, runtime_sha256);
    descriptor
}

fn manifest(descriptor: EngineDescriptor) -> WorkerManifest {
    WorkerManifest {
        worker_id: id("sherpa-native-smoke-worker"),
        role: WorkerRole::NativeCandidate,
        worker_build_sha256: digest(21),
        executable_sha256: digest(22),
        schema_registry_sha256: digest(23),
        descriptor,
    }
}

fn limits() -> WorkerLimits {
    WorkerLimits {
        max_control_message_bytes: 1_048_576,
        max_audio_chunk_bytes: 4_194_304,
        max_pending_audio_bytes: 16_777_216,
        max_capture_epochs_per_chunk: 8,
        max_source_ranges_per_chunk: 32,
        max_in_flight_jobs: 8,
        max_tracked_jobs: 64,
        max_retired_job_keys: 128,
        max_pending_commands: 8,
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

fn hold_for_loaded_module_probe() {
    let Some(ready_file) = env::var_os("MEETINGRELAY_SHERPA_MODULE_PROBE_READY_FILE") else {
        return;
    };
    let hold_ms = env::var("MEETINGRELAY_SHERPA_MODULE_PROBE_HOLD_MS")
        .expect("module probe hold is required with a ready file")
        .parse::<u64>()
        .expect("module probe hold must be a decimal millisecond value");
    assert!(
        (1..=15_000).contains(&hold_ms),
        "module probe hold must be between 1 and 15000 milliseconds"
    );
    fs::write(PathBuf::from(ready_file), std::process::id().to_string())
        .expect("publish module probe PID");
    std::thread::sleep(std::time::Duration::from_millis(hold_ms));
}

fn digest(byte: u8) -> Sha256Digest {
    Sha256Digest::from_bytes([byte; 32])
}

fn id(value: &str) -> Identifier {
    Identifier::new(value).expect("valid smoke identifier")
}

fn language(value: &str) -> LanguageCode {
    LanguageCode::new(value).expect("valid smoke language")
}

fn read_mono_pcm16_wav(path: &Path) -> Vec<i16> {
    let bytes = fs::read(path).expect("read configured WAV");
    assert!(bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE");
    let mut offset = 12_usize;
    let mut format = None;
    let mut data = None;
    while offset.checked_add(8).is_some_and(|end| end <= bytes.len()) {
        let id = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes(
            bytes[offset + 4..offset + 8]
                .try_into()
                .expect("WAV chunk size"),
        ) as usize;
        let start = offset + 8;
        let end = start.checked_add(size).expect("WAV chunk size overflow");
        assert!(end <= bytes.len(), "truncated WAV chunk");
        if id == b"fmt " {
            assert!(size >= 16, "short WAV fmt chunk");
            format = Some((
                u16::from_le_bytes(bytes[start..start + 2].try_into().expect("audio format")),
                u16::from_le_bytes(bytes[start + 2..start + 4].try_into().expect("channels")),
                u32::from_le_bytes(bytes[start + 4..start + 8].try_into().expect("sample rate")),
                u16::from_le_bytes(
                    bytes[start + 14..start + 16]
                        .try_into()
                        .expect("bits per sample"),
                ),
            ));
        } else if id == b"data" {
            data = Some(&bytes[start..end]);
        }
        offset = end + (size & 1);
    }
    assert_eq!(format, Some((1, 1, SAMPLE_RATE_HZ, 16)));
    let data = data.expect("WAV data chunk");
    assert!(!data.is_empty() && data.len() % 2 == 0);
    data.chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect()
}
