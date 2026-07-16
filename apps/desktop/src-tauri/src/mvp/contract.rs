use serde::Serialize;

pub const MVP_CONTRACT_VERSION: &str = "meetingrelay.mvp.v1";
pub const MAX_FINAL_SEGMENTS: usize = 64;
pub const MAX_INFERENCE_QUEUE_DEPTH: usize = 8;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Lifecycle {
    Booting,
    Ready,
    Starting,
    Recording,
    Stopping,
    Error,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceId {
    System,
    Microphone,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceStatus {
    Ready,
    Capturing,
    Degraded,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSourceSnapshot {
    pub id: SourceId,
    pub label: String,
    pub ready: bool,
    pub active: bool,
    pub frames: String,
    pub peak: f32,
    pub status: SourceStatus,
    pub error: Option<String>,
}

impl AudioSourceSnapshot {
    pub fn unavailable(id: SourceId, error: impl Into<String>) -> Self {
        Self {
            id,
            label: String::new(),
            ready: false,
            active: false,
            frames: "0".to_owned(),
            peak: 0.0,
            status: SourceStatus::Error,
            error: Some(error.into()),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub segment_id: String,
    pub revision: u32,
    pub is_final: bool,
    pub text: String,
    pub started_at_ms: String,
    pub ended_at_ms: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MvpSnapshot {
    pub contract_version: String,
    pub lifecycle: Lifecycle,
    pub model_ready: bool,
    pub model_label: String,
    pub local_only: bool,
    pub memory_only: bool,
    pub session_id: Option<String>,
    pub elapsed_ms: String,
    pub system: AudioSourceSnapshot,
    pub microphone: AudioSourceSnapshot,
    pub interim: Option<TranscriptSegment>,
    pub finals: Vec<TranscriptSegment>,
    pub queue_depth: usize,
    pub error: Option<String>,
}

impl MvpSnapshot {
    pub fn booting() -> Self {
        Self {
            contract_version: MVP_CONTRACT_VERSION.to_owned(),
            lifecycle: Lifecycle::Booting,
            model_ready: false,
            model_label: "SenseVoice local CPU".to_owned(),
            local_only: true,
            memory_only: true,
            session_id: None,
            elapsed_ms: "0".to_owned(),
            system: AudioSourceSnapshot::unavailable(SourceId::System, "AUDIO_NOT_PROBED"),
            microphone: AudioSourceSnapshot::unavailable(SourceId::Microphone, "AUDIO_NOT_PROBED"),
            interim: None,
            finals: Vec::new(),
            queue_depth: 0,
            error: None,
        }
    }

    pub fn enforce_bounds(&mut self) {
        if self.finals.len() > MAX_FINAL_SEGMENTS {
            let remove = self.finals.len() - MAX_FINAL_SEGMENTS;
            self.finals.drain(..remove);
        }
        self.queue_depth = self.queue_depth.min(MAX_INFERENCE_QUEUE_DEPTH);
        self.system.peak = self.system.peak.clamp(0.0, 1.0);
        self.microphone.peak = self.microphone.peak.clamp(0.0, 1.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn booting_snapshot_serializes_to_the_frontend_contract_shape() {
        use tauri::ipc::{InvokeResponseBody, IpcResponse};

        let InvokeResponseBody::Json(json) =
            MvpSnapshot::booting().body().expect("serialize snapshot")
        else {
            panic!("snapshot must use a JSON response body");
        };
        assert!(json.contains(r#""contractVersion":"meetingrelay.mvp.v1""#));
        assert!(json.contains(r#""lifecycle":"booting""#));
        assert!(json.contains(r#""localOnly":true,"memoryOnly":true"#));
        assert!(json.contains(r#""id":"system""#));
        assert!(json.contains(r#""id":"microphone""#));
        assert!(json.contains(r#""elapsedMs":"0""#));
    }

    #[test]
    fn snapshot_bounds_keep_the_latest_finals_and_clamp_public_counters() {
        let mut snapshot = MvpSnapshot::booting();
        snapshot.finals = (0..70)
            .map(|index| TranscriptSegment {
                segment_id: format!("segment-{index}"),
                revision: 1,
                is_final: true,
                text: index.to_string(),
                started_at_ms: "0".to_owned(),
                ended_at_ms: Some("1".to_owned()),
            })
            .collect();
        snapshot.queue_depth = 99;
        snapshot.system.peak = 1.5;
        snapshot.microphone.peak = -1.0;

        snapshot.enforce_bounds();

        assert_eq!(snapshot.finals.len(), MAX_FINAL_SEGMENTS);
        assert_eq!(snapshot.finals[0].segment_id, "segment-6");
        assert_eq!(snapshot.queue_depth, MAX_INFERENCE_QUEUE_DEPTH);
        assert_eq!(snapshot.system.peak, 1.0);
        assert_eq!(snapshot.microphone.peak, 0.0);
    }
}
