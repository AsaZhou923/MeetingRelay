use std::{
    env, fmt, fs,
    io::{BufRead, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{Receiver, RecvTimeoutError, sync_channel},
    thread::{self, JoinHandle},
    time::Duration,
};

use serde_json::{Value, json};

pub const MODEL_ID: &str = "cohere-transcribe-03-2026";
pub const MODEL_LABEL: &str = "Cohere Transcribe 2B";
pub const MODEL_REVISION: &str = "b1eacc2686a3d08ceaae5f24a88b1d519620bc09";
pub const MODEL_SHA256: &str = "987bd3e141c7bfdb5a78f5db11397ee7737308357e6cc0a3f36a4979b158137a";
pub const MODEL_SIZE_BYTES: u64 = 4_131_862_976;
pub const ENGINE_ID: &str = "transformers";
pub const ENGINE_VERSION: &str = "5.4.0";
pub const RUNTIME_VERSION: &str = "torch-2.10.0+cu128";
pub const MODEL_LICENSE_ID: &str = "Apache-2.0";
pub const QUANTIZATION: &str = "bf16";
pub const MAX_SAMPLE_COUNT: usize = 16_000 * 120;

const PREPARE_TIMEOUT: Duration = Duration::from_secs(120);
const INFERENCE_TIMEOUT: Duration = Duration::from_secs(60);
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CohereAsrConfig {
    pub python_path: PathBuf,
    pub model_dir: PathBuf,
    pub worker_path: PathBuf,
}

impl CohereAsrConfig {
    pub fn resolve() -> Result<Self, CohereAsrError> {
        let python_path = first_file(python_candidates()).ok_or(CohereAsrError::RuntimeMissing)?;
        let worker_path = first_file(worker_candidates()).ok_or(CohereAsrError::WorkerMissing)?;
        let model_dir =
            first_valid_model_dir(model_candidates()).ok_or(CohereAsrError::ModelMissing)?;
        validate_model_file(&model_dir)?;
        Ok(Self {
            python_path,
            model_dir,
            worker_path,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CohereInstallState {
    Verified,
    Missing,
    Invalid,
}

#[must_use]
pub fn installation_state() -> CohereInstallState {
    match CohereAsrConfig::resolve() {
        Ok(_) => CohereInstallState::Verified,
        Err(CohereAsrError::ModelInvalid) => CohereInstallState::Invalid,
        Err(_) => CohereInstallState::Missing,
    }
}

#[derive(Debug)]
pub enum CohereAsrError {
    RuntimeMissing,
    WorkerMissing,
    ModelMissing,
    ModelInvalid,
    SpawnFailed,
    ProcessExited,
    Timeout,
    Io,
    ProtocolInvalid,
    EmptySegment,
    SegmentTooLarge,
    Worker(String),
}

impl CohereAsrError {
    #[must_use]
    pub fn recoverable(&self) -> bool {
        matches!(
            self,
            Self::SpawnFailed
                | Self::ProcessExited
                | Self::Timeout
                | Self::Io
                | Self::ProtocolInvalid
        )
    }

    fn code(&self) -> &str {
        match self {
            Self::RuntimeMissing => "COHERE_ASR_RUNTIME_MISSING",
            Self::WorkerMissing => "COHERE_ASR_WORKER_MISSING",
            Self::ModelMissing => "COHERE_ASR_MODEL_MISSING",
            Self::ModelInvalid => "COHERE_ASR_MODEL_INVALID",
            Self::SpawnFailed => "COHERE_ASR_WORKER_START_FAILED",
            Self::ProcessExited => "COHERE_ASR_WORKER_STOPPED",
            Self::Timeout => "COHERE_ASR_TIMEOUT",
            Self::Io => "COHERE_ASR_IO_FAILED",
            Self::ProtocolInvalid => "COHERE_ASR_PROTOCOL_INVALID",
            Self::EmptySegment => "COHERE_ASR_EMPTY_SEGMENT",
            Self::SegmentTooLarge => "COHERE_ASR_SEGMENT_TOO_LARGE",
            Self::Worker(code) => code,
        }
    }
}

impl fmt::Display for CohereAsrError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

pub struct CohereAsrSidecar {
    child: Child,
    input: Option<BufWriter<ChildStdin>>,
    responses: Receiver<Result<String, ()>>,
    reader: Option<JoinHandle<()>>,
    next_request_id: u64,
}

impl fmt::Debug for CohereAsrSidecar {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CohereAsrSidecar")
            .field("child_id", &self.child.id())
            .finish_non_exhaustive()
    }
}

impl CohereAsrSidecar {
    pub fn prepare(config: &CohereAsrConfig) -> Result<Self, CohereAsrError> {
        let mut command = Command::new(&config.python_path);
        command
            .arg("-I")
            .arg("-u")
            .arg(&config.worker_path)
            .current_dir(
                config
                    .worker_path
                    .parent()
                    .ok_or(CohereAsrError::WorkerMissing)?,
            )
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .env("HF_HUB_OFFLINE", "1")
            .env("TRANSFORMERS_OFFLINE", "1")
            .env("HF_HUB_DISABLE_PROGRESS_BARS", "1")
            .env("TRANSFORMERS_VERBOSITY", "error")
            .env("MEETINGRELAY_COHERE_MODEL_DIR", &config.model_dir)
            .env("MEETINGRELAY_COHERE_MODEL_SHA256", MODEL_SHA256)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command.spawn().map_err(|_| CohereAsrError::SpawnFailed)?;
        let input = child
            .stdin
            .take()
            .map(BufWriter::new)
            .ok_or(CohereAsrError::SpawnFailed)?;
        let stdout = child.stdout.take().ok_or(CohereAsrError::SpawnFailed)?;
        let (sender, responses) = sync_channel(8);
        let reader = thread::Builder::new()
            .name("meetingrelay-cohere-stdout".to_owned())
            .spawn(move || {
                let mut stdout = BufReader::new(stdout);
                loop {
                    let mut line = String::new();
                    match stdout.read_line(&mut line) {
                        Ok(0) => {
                            let _ = sender.send(Err(()));
                            break;
                        }
                        Ok(_) => {
                            if sender.send(Ok(line)).is_err() {
                                break;
                            }
                        }
                        Err(_) => {
                            let _ = sender.send(Err(()));
                            break;
                        }
                    }
                }
            })
            .map_err(|_| CohereAsrError::SpawnFailed)?;

        let mut sidecar = Self {
            child,
            input: Some(input),
            responses,
            reader: Some(reader),
            next_request_id: 1,
        };
        let ready = sidecar.receive(PREPARE_TIMEOUT)?;
        match message_type(&ready)? {
            "ready" if string_field(&ready, "modelId")? == MODEL_ID => Ok(sidecar),
            "error" => Err(worker_error(&ready)),
            _ => Err(CohereAsrError::ProtocolInvalid),
        }
    }

    pub fn transcribe_mono_16khz_pcm16(
        &mut self,
        samples: &[i16],
        language: &str,
    ) -> Result<String, CohereAsrError> {
        if samples.is_empty() {
            return Err(CohereAsrError::EmptySegment);
        }
        if samples.len() > MAX_SAMPLE_COUNT {
            return Err(CohereAsrError::SegmentTooLarge);
        }
        if !matches!(language, "en" | "ja" | "zh") {
            return Err(CohereAsrError::ProtocolInvalid);
        }

        let request_id = self.next_request_id;
        self.next_request_id = self.next_request_id.checked_add(1).unwrap_or(1);
        let header = json!({
            "type": "transcribe",
            "id": request_id,
            "language": language,
            "sampleRateHz": 16_000,
            "sampleCount": samples.len(),
        })
        .to_string();
        let mut payload = Vec::with_capacity(samples.len().saturating_mul(2));
        for sample in samples {
            payload.extend_from_slice(&sample.to_le_bytes());
        }

        let input = self.input.as_mut().ok_or(CohereAsrError::ProcessExited)?;
        input
            .write_all(header.as_bytes())
            .and_then(|()| input.write_all(b"\n"))
            .and_then(|()| input.write_all(&payload))
            .and_then(|()| input.flush())
            .map_err(|_| CohereAsrError::Io)?;

        let response = self.receive(INFERENCE_TIMEOUT)?;
        let response_id = u64_field(&response, "id")?;
        if response_id != request_id {
            return Err(CohereAsrError::ProtocolInvalid);
        }
        match message_type(&response)? {
            "result" => Ok(string_field(&response, "text")?.trim().to_owned()),
            "error" => Err(worker_error(&response)),
            _ => Err(CohereAsrError::ProtocolInvalid),
        }
    }

    fn receive(&mut self, timeout: Duration) -> Result<Value, CohereAsrError> {
        let line = match self.responses.recv_timeout(timeout) {
            Ok(Ok(line)) => line,
            Ok(Err(())) => return Err(CohereAsrError::ProcessExited),
            Err(RecvTimeoutError::Timeout) => return Err(CohereAsrError::Timeout),
            Err(RecvTimeoutError::Disconnected) => return Err(CohereAsrError::ProcessExited),
        };
        serde_json::from_str(&line).map_err(|_| CohereAsrError::ProtocolInvalid)
    }

    pub fn shutdown(&mut self) {
        if let Some(mut input) = self.input.take() {
            let _ = input.write_all(b"{\"type\":\"shutdown\"}\n");
            let _ = input.flush();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

impl Drop for CohereAsrSidecar {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn validate_model_file(model_dir: &Path) -> Result<(), CohereAsrError> {
    let model_file = model_dir.join("model.safetensors");
    let metadata = fs::metadata(model_file).map_err(|_| CohereAsrError::ModelMissing)?;
    if !metadata.is_file() || metadata.len() != MODEL_SIZE_BYTES {
        return Err(CohereAsrError::ModelInvalid);
    }
    Ok(())
}

fn first_file(candidates: Vec<PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|candidate| candidate.is_file())
}

fn first_valid_model_dir(candidates: Vec<PathBuf>) -> Option<PathBuf> {
    candidates
        .into_iter()
        .find(|candidate| candidate.join("model.safetensors").is_file())
}

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn python_candidates() -> Vec<PathBuf> {
    let mut candidates = env::var_os("MEETINGRELAY_COHERE_PYTHON")
        .map(PathBuf::from)
        .into_iter()
        .collect::<Vec<_>>();
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local_app_data)
                .join("MeetingRelay/runtimes/cohere-transcribe-03-2026/Scripts/python.exe"),
        );
    }
    candidates.push(workspace_root().join("target/cohere-transcribe/venv/Scripts/python.exe"));
    for ancestor in workspace_root().ancestors() {
        candidates
            .push(ancestor.join(".codex-runtime/meetingrelay-cohere-test/Scripts/python.exe"));
    }
    candidates
}

fn worker_candidates() -> Vec<PathBuf> {
    let mut candidates = env::var_os("MEETINGRELAY_COHERE_WORKER")
        .map(PathBuf::from)
        .into_iter()
        .collect::<Vec<_>>();
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local_app_data)
                .join("MeetingRelay/runtimes/cohere-transcribe-03-2026/worker.py"),
        );
    }
    candidates.push(workspace_root().join("tools/cohere-transcribe/worker.py"));
    if let Ok(executable) = env::current_exe()
        && let Some(exe_dir) = executable.parent()
    {
        candidates.push(exe_dir.join("cohere-transcribe/worker.py"));
    }
    candidates
}

fn project_model_dir() -> PathBuf {
    workspace_root()
        .join("target/cohere-transcribe/models")
        .join(MODEL_ID)
        .join(MODEL_REVISION)
}

fn model_candidates() -> Vec<PathBuf> {
    let mut candidates = env::var_os("MEETINGRELAY_COHERE_MODEL_DIR")
        .map(PathBuf::from)
        .into_iter()
        .collect::<Vec<_>>();
    candidates.push(project_model_dir());
    let hub = if let Some(cache) = env::var_os("HF_HUB_CACHE") {
        PathBuf::from(cache)
    } else if let Some(home) = env::var_os("HF_HOME") {
        PathBuf::from(home).join("hub")
    } else if let Some(user_profile) = env::var_os("USERPROFILE") {
        PathBuf::from(user_profile).join(".cache/huggingface/hub")
    } else {
        return candidates;
    };
    candidates.push(
        hub.join("models--CohereLabs--cohere-transcribe-03-2026")
            .join("snapshots")
            .join(MODEL_REVISION),
    );
    candidates
}

fn message_type(value: &Value) -> Result<&str, CohereAsrError> {
    string_field(value, "type")
}

fn string_field<'a>(value: &'a Value, field: &str) -> Result<&'a str, CohereAsrError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or(CohereAsrError::ProtocolInvalid)
}

fn u64_field(value: &Value, field: &str) -> Result<u64, CohereAsrError> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .ok_or(CohereAsrError::ProtocolInvalid)
}

fn worker_error(value: &Value) -> CohereAsrError {
    let Ok(code) = string_field(value, "code") else {
        return CohereAsrError::ProtocolInvalid;
    };
    if code.is_empty()
        || code.len() > 64
        || !code
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return CohereAsrError::ProtocolInvalid;
    }
    CohereAsrError::Worker(code.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bounded_worker_errors() {
        let valid = json!({"type": "error", "code": "COHERE_ASR_INFERENCE_FAILED"});
        assert_eq!(
            worker_error(&valid).to_string(),
            "COHERE_ASR_INFERENCE_FAILED"
        );
        let invalid = json!({"type": "error", "code": "path: C:\\secret"});
        assert!(matches!(
            worker_error(&invalid),
            CohereAsrError::ProtocolInvalid
        ));
    }

    #[test]
    fn validates_the_locked_model_size() {
        let root = env::temp_dir().join(format!(
            "meetingrelay-cohere-model-size-{}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let file = fs::File::create(root.join("model.safetensors")).unwrap();
        file.set_len(MODEL_SIZE_BYTES).unwrap();
        assert!(validate_model_file(&root).is_ok());
        file.set_len(MODEL_SIZE_BYTES - 1).unwrap();
        assert!(matches!(
            validate_model_file(&root),
            Err(CohereAsrError::ModelInvalid)
        ));
        drop(file);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn discovers_the_project_local_locked_model() {
        let expected = workspace_root()
            .join("target/cohere-transcribe/models/cohere-transcribe-03-2026")
            .join(MODEL_REVISION);
        assert!(model_candidates().contains(&expected));
    }

    #[test]
    #[ignore = "requires the locked Cohere model, Python runtime, and an NVIDIA CUDA GPU"]
    fn live_cuda_sidecar_prepares_and_accepts_framed_pcm16() {
        let config = CohereAsrConfig::resolve().expect("resolve Cohere installation");
        let mut sidecar = CohereAsrSidecar::prepare(&config).expect("prepare Cohere sidecar");
        let silence = vec![0_i16; 16_000];
        sidecar
            .transcribe_mono_16khz_pcm16(&silence, "ja")
            .expect("transcribe framed audio");
    }
}
