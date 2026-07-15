use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use meetingrelay_model_worker_contract::{
    Architecture, AudioChunk, AudioFormat, AudioGap, AudioPayload, AudioSource, BackendAction,
    BackendFailure, BackendOutcome, CapabilitySet, ContractPurpose, DirectWorkerSession,
    EngineDescriptor, ExecutionProvider, GapReason, HelloRequest, Identifier, LanguageCode,
    ModelBackend, OperatingSystem, Platform, SampleFormat, SanitizedText, Sha256Digest,
    SourceRange, TranscriptProvenance, TranscriptResult, TranscriptText, WORKER_PROTOCOL_V1,
    WorkerLimits, WorkerManifest, WorkerRole, run_native_candidate_semantic_conformance,
};

struct CandidateBackend {
    execute_calls: Arc<AtomicUsize>,
}

impl ModelBackend for CandidateBackend {
    fn prepare(&mut self) -> Result<(), BackendFailure> {
        Ok(())
    }

    fn execute(&mut self, action: &BackendAction) -> BackendOutcome {
        self.execute_calls.fetch_add(1, Ordering::Relaxed);
        action.completed(TranscriptResult {
            original_transcript: TranscriptText::new("candidate semantic transcript")
                .expect("constant transcript"),
            raw_language: SanitizedText::new("zh").expect("constant raw language"),
            normalized_language: language("zh"),
            confidence: None,
            provenance: TranscriptProvenance::from_descriptor(&descriptor()),
        })
    }
}

#[test]
fn direct_native_candidate_shape_passes_the_generic_semantic_runner() {
    let execute_calls = Arc::new(AtomicUsize::new(0));
    let manifest = manifest();
    let limits = limits();
    let backend = CandidateBackend {
        execute_calls: Arc::clone(&execute_calls),
    };
    let mut session =
        DirectWorkerSession::new(manifest.clone(), limits, backend).expect("direct candidate");
    let first = chunk(1, 0, &[1, 2, 3, 4]);
    let gap = AudioGap {
        sequence: 2,
        media_start_sample: first.media_end_sample,
        media_end_sample: first.media_end_sample + 2,
        reason: GapReason::CaptureDiscontinuity,
    };
    let second = chunk(3, gap.media_end_sample, &[5, 6, 7, 8]);

    let observation = run_native_candidate_semantic_conformance(
        &mut session,
        HelloRequest {
            protocol: WORKER_PROTOCOL_V1,
            platform: Platform {
                operating_system: OperatingSystem::Windows,
                architecture: Architecture::X86_64,
            },
            core_build_sha256: digest(9),
            purpose: ContractPurpose::ProductShellCandidate,
            expected: manifest,
            required_capabilities: CapabilitySet::required_v1(),
            offered_limits: limits,
        },
        id("core-fixture-clock"),
        first,
        gap,
        second,
    )
    .expect("candidate semantic conformance");

    assert_eq!(
        observation.final_result.original_transcript.as_str(),
        "candidate semantic transcript"
    );
    assert_eq!(observation.final_transcript_utf8_bytes, 29);
    assert_eq!(execute_calls.load(Ordering::Relaxed), 1);
}

fn manifest() -> WorkerManifest {
    WorkerManifest {
        worker_id: id("candidate-conformance-test-worker"),
        role: WorkerRole::NativeCandidate,
        worker_build_sha256: digest(6),
        executable_sha256: digest(7),
        schema_registry_sha256: digest(8),
        descriptor: descriptor(),
    }
}

fn descriptor() -> EngineDescriptor {
    EngineDescriptor {
        engine_id: id("candidate-engine"),
        engine_version: id("1.0.0"),
        runtime_id: id("candidate-runtime"),
        runtime_version: id("1.0.0"),
        runtime_sha256: digest(1),
        package_lock_sha256: digest(2),
        model_id: id("candidate-model"),
        model_sha256: digest(3),
        model_manifest_sha256: digest(4),
        model_license_id: id("LicenseRef-Test"),
        parameter_sha256: digest(5),
        execution_provider: ExecutionProvider::Cpu,
        quantization: id("int8"),
        languages: vec![language("zh")],
        streaming: true,
        offline: true,
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

fn chunk(sequence: u64, media_start_sample: u64, samples: &[i16]) -> AudioChunk {
    let sample_count = u64::try_from(samples.len()).expect("sample count");
    let media_end_sample = media_start_sample + sample_count;
    let capture_epoch_id = id("candidate-conformance-capture-epoch");
    AudioChunk {
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
            device_start_sample: media_start_sample,
            device_end_sample: media_end_sample,
            meeting_start_sample: media_start_sample,
            meeting_end_sample: media_end_sample,
            sample_rate_hz: 16_000,
        }],
        payload_bytes: sample_count * 2,
        payload_sha256: Some(digest(u8::try_from(sequence).expect("small sequence"))),
        payload: Some(AudioPayload::PcmS16Le(Arc::from(samples))),
    }
}

fn digest(value: u8) -> Sha256Digest {
    Sha256Digest::from_bytes([value; 32])
}

fn id(value: &str) -> Identifier {
    Identifier::new(value).expect("valid test identifier")
}

fn language(value: &str) -> LanguageCode {
    LanguageCode::new(value).expect("valid test language")
}
