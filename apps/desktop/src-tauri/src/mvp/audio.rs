//! Minimal Windows audio capture for the MeetingRelay MVP.
//!
//! CPAL's WASAPI backend treats an input stream built on a render device as a
//! loopback stream. We use that behavior for the default system output and a
//! normal input stream for the default microphone. The callbacks deliberately
//! publish raw, interleaved `f32` samples so resampling and downmixing can stay
//! outside the real-time capture boundary.

use std::{
    error::Error,
    fmt,
    sync::{
        Arc,
        atomic::{AtomicU32, AtomicU64, Ordering},
        mpsc::{Receiver, SyncSender},
    },
};

#[cfg(any(windows, test))]
use std::sync::mpsc::{TrySendError, sync_channel};

/// Default number of audio packets that may wait for the consumer.
pub const DEFAULT_PACKET_QUEUE_CAPACITY: usize = 32;
/// Default number of capture status messages that may wait for the consumer.
pub const DEFAULT_STATUS_QUEUE_CAPACITY: usize = 16;
/// Maximum serialized CPAL device identifier accepted across IPC.
pub const MAX_DEVICE_ID_LENGTH: usize = 1024;

/// Stable identifiers for the two MVP capture sources.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum AudioSourceId {
    /// Audio currently rendered by the default Windows output endpoint.
    SystemOutput,
    /// Audio captured by the default Windows input endpoint.
    Microphone,
}

impl fmt::Display for AudioSourceId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SystemOutput => formatter.write_str("system-output"),
            Self::Microphone => formatter.write_str("microphone"),
        }
    }
}

/// Sample formats accepted at the CPAL boundary.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum AudioSampleFormat {
    F32,
    I16,
    U16,
}

/// The default device and stream format selected during preflight.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AudioDevicePreflight {
    pub source: AudioSourceId,
    pub device_id: String,
    pub name: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub sample_format: AudioSampleFormat,
}

/// Both default endpoints required by the MVP capture session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AudioCapturePreflight {
    pub system_output: AudioDevicePreflight,
    pub microphone: AudioDevicePreflight,
}

/// One currently available device suitable for an MVP capture role.
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceInventoryItem {
    pub device_id: String,
    pub name: String,
    pub is_default: bool,
}

/// Selectable Windows render and capture devices.
#[derive(Clone, Debug, Default, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceInventory {
    pub system_outputs: Vec<AudioDeviceInventoryItem>,
    pub microphones: Vec<AudioDeviceInventoryItem>,
}

/// Optional explicit endpoints for a capture session.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct AudioDeviceSelection {
    pub system_output_device_id: Option<String>,
    pub microphone_device_id: Option<String>,
}

/// Raw audio passed to the sibling processing service.
///
/// Samples remain interleaved. The consumer is responsible for downmixing,
/// resampling, chunk assembly, and clock reconciliation between sources.
#[derive(Clone, Debug, PartialEq)]
pub struct RawAudioPacket {
    pub source: AudioSourceId,
    pub sample_rate: u32,
    pub channels: u16,
    pub samples: Vec<f32>,
}

impl RawAudioPacket {
    /// Number of complete interleaved frames in this packet.
    #[must_use]
    pub fn frame_count(&self) -> usize {
        let channels = usize::from(self.channels);
        self.samples.len().checked_div(channels).unwrap_or(0)
    }
}

/// Why a raw packet could not be delivered.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AudioPacketDropReason {
    QueueFull,
    ReceiverDisconnected,
}

/// State changes and recoverable runtime failures emitted by capture streams.
#[derive(Clone, Debug, PartialEq)]
pub enum AudioCaptureStatusKind {
    Started,
    PacketDropped {
        total_dropped_packets: u64,
        reason: AudioPacketDropReason,
    },
    StreamError {
        message: String,
    },
    Stopped,
}

/// A source-qualified capture status event.
#[derive(Clone, Debug, PartialEq)]
pub struct AudioCaptureStatus {
    pub source: AudioSourceId,
    pub kind: AudioCaptureStatusKind,
}

/// Point-in-time counters for one capture source.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AudioSourceStats {
    pub captured_frames: u64,
    pub peak: f32,
    pub dropped_packets: u64,
    pub stream_errors: u64,
    pub dropped_statuses: u64,
}

#[derive(Debug, Default)]
struct SourceCounters {
    captured_frames: AtomicU64,
    peak_bits: AtomicU32,
    dropped_packets: AtomicU64,
    stream_errors: AtomicU64,
    dropped_statuses: AtomicU64,
}

impl SourceCounters {
    fn snapshot(&self) -> AudioSourceStats {
        AudioSourceStats {
            captured_frames: self.captured_frames.load(Ordering::Relaxed),
            peak: f32::from_bits(self.peak_bits.load(Ordering::Relaxed)),
            dropped_packets: self.dropped_packets.load(Ordering::Relaxed),
            stream_errors: self.stream_errors.load(Ordering::Relaxed),
            dropped_statuses: self.dropped_statuses.load(Ordering::Relaxed),
        }
    }

    fn set_peak(&self, peak: f32) {
        self.peak_bits.store(peak.to_bits(), Ordering::Relaxed);
    }
}

/// Cheaply clonable atomic metrics shared with the capture callbacks.
#[derive(Clone, Debug, Default)]
pub struct AudioCaptureMetrics {
    system_output: Arc<SourceCounters>,
    microphone: Arc<SourceCounters>,
}

impl AudioCaptureMetrics {
    /// Read a non-transactional snapshot for one source.
    #[must_use]
    pub fn snapshot(&self, source: AudioSourceId) -> AudioSourceStats {
        self.counters(source).snapshot()
    }

    fn counters(&self, source: AudioSourceId) -> Arc<SourceCounters> {
        match source {
            AudioSourceId::SystemOutput => Arc::clone(&self.system_output),
            AudioSourceId::Microphone => Arc::clone(&self.microphone),
        }
    }
}

/// Bounded queue sizing for a new capture session.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AudioCaptureOptions {
    pub packet_queue_capacity: usize,
    pub status_queue_capacity: usize,
}

impl Default for AudioCaptureOptions {
    fn default() -> Self {
        Self {
            packet_queue_capacity: DEFAULT_PACKET_QUEUE_CAPACITY,
            status_queue_capacity: DEFAULT_STATUS_QUEUE_CAPACITY,
        }
    }
}

impl AudioCaptureOptions {
    fn validate(self) -> Result<Self, AudioCaptureError> {
        if self.packet_queue_capacity == 0 {
            return Err(AudioCaptureError::InvalidQueueCapacity { queue: "packet" });
        }
        if self.status_queue_capacity == 0 {
            return Err(AudioCaptureError::InvalidQueueCapacity { queue: "status" });
        }
        Ok(self)
    }
}

/// The consumer-facing half of a capture session.
pub struct AudioCaptureOutput {
    pub packets: Receiver<RawAudioPacket>,
    pub statuses: Receiver<AudioCaptureStatus>,
    pub metrics: AudioCaptureMetrics,
    pub preflight: AudioCapturePreflight,
}

/// Errors raised while preflighting or starting the local capture session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AudioCaptureError {
    UnsupportedPlatform,
    InvalidQueueCapacity {
        queue: &'static str,
    },
    DefaultDeviceUnavailable {
        source: AudioSourceId,
    },
    DeviceQueryFailed {
        source: AudioSourceId,
        operation: &'static str,
        message: String,
    },
    InvalidDeviceId {
        source: AudioSourceId,
        reason: &'static str,
    },
    SelectedDeviceUnavailable {
        source: AudioSourceId,
    },
    SelectedDeviceRoleMismatch {
        source: AudioSourceId,
    },
    SelectedDeviceOpenFailed {
        source: AudioSourceId,
        message: String,
    },
    UnsupportedSampleFormat {
        source: AudioSourceId,
        format: String,
    },
    StreamBuildFailed {
        source: AudioSourceId,
        message: String,
    },
    StreamStartFailed {
        source: AudioSourceId,
        message: String,
    },
}

impl fmt::Display for AudioCaptureError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedPlatform => {
                formatter.write_str("MVP audio capture is only supported on Windows")
            }
            Self::InvalidQueueCapacity { queue } => {
                write!(
                    formatter,
                    "{queue} queue capacity must be greater than zero"
                )
            }
            Self::DefaultDeviceUnavailable { source } => {
                write!(formatter, "default {source} device is unavailable")
            }
            Self::DeviceQueryFailed {
                source,
                operation,
                message,
            } => write!(
                formatter,
                "failed to query {operation} for default {source} device: {message}"
            ),
            Self::InvalidDeviceId { source, reason } => {
                write!(formatter, "invalid {source} device id: {reason}")
            }
            Self::SelectedDeviceUnavailable { source } => {
                write!(formatter, "selected {source} device is unavailable")
            }
            Self::SelectedDeviceRoleMismatch { source } => {
                write!(formatter, "selected device is not a {source} device")
            }
            Self::SelectedDeviceOpenFailed { source, message } => {
                write!(
                    formatter,
                    "failed to open selected {source} device: {message}"
                )
            }
            Self::UnsupportedSampleFormat { source, format } => {
                write!(formatter, "default {source} format {format} is unsupported")
            }
            Self::StreamBuildFailed { source, message } => {
                write!(
                    formatter,
                    "failed to build {source} capture stream: {message}"
                )
            }
            Self::StreamStartFailed { source, message } => {
                write!(
                    formatter,
                    "failed to start {source} capture stream: {message}"
                )
            }
        }
    }
}

impl Error for AudioCaptureError {}

/// RAII owner for both live CPAL streams.
///
/// Calling [`Self::stop`] is optional. Dropping this value releases both
/// streams and emits best-effort `Stopped` status events without blocking.
pub struct AudioCapture {
    #[cfg(windows)]
    streams: Option<Vec<cpal::Stream>>,
    active_sources: Vec<AudioSourceId>,
    status_sender: SyncSender<AudioCaptureStatus>,
    metrics: AudioCaptureMetrics,
    stopped: bool,
}

impl AudioCapture {
    /// Enumerate devices that can provide the role's default stream format.
    pub fn device_inventory() -> Result<AudioDeviceInventory, AudioCaptureError> {
        #[cfg(windows)]
        {
            platform::device_inventory()
        }
        #[cfg(not(windows))]
        {
            Err(AudioCaptureError::UnsupportedPlatform)
        }
    }

    /// Inspect the current Windows default render and capture endpoints.
    pub fn preflight_default_devices() -> Result<AudioCapturePreflight, AudioCaptureError> {
        #[cfg(windows)]
        {
            platform::preflight_default_devices()
        }
        #[cfg(not(windows))]
        {
            Err(AudioCaptureError::UnsupportedPlatform)
        }
    }

    /// Start WASAPI loopback plus microphone capture using bounded queues.
    pub fn start_default(
        options: AudioCaptureOptions,
    ) -> Result<(Self, AudioCaptureOutput), AudioCaptureError> {
        Self::start(options, AudioDeviceSelection::default())
    }

    /// Start capture with explicit endpoints when supplied, otherwise legacy defaults.
    pub fn start(
        options: AudioCaptureOptions,
        selection: AudioDeviceSelection,
    ) -> Result<(Self, AudioCaptureOutput), AudioCaptureError> {
        let options = options.validate()?;
        #[cfg(windows)]
        {
            platform::start(options, selection)
        }
        #[cfg(not(windows))]
        {
            let _ = (options, selection);
            Err(AudioCaptureError::UnsupportedPlatform)
        }
    }

    /// Clone the shared atomic metrics handle.
    #[must_use]
    pub fn metrics(&self) -> AudioCaptureMetrics {
        self.metrics.clone()
    }

    /// Whether this handle still owns the active streams.
    #[must_use]
    pub fn is_running(&self) -> bool {
        !self.stopped
    }

    /// Stop both streams immediately. Dropping the handle has the same effect.
    pub fn stop(mut self) {
        self.stop_inner();
    }

    fn stop_inner(&mut self) {
        if self.stopped {
            return;
        }

        #[cfg(windows)]
        if let Some(streams) = self.streams.take() {
            drop(streams);
        }

        for source in self.active_sources.drain(..) {
            let counters = self.metrics.counters(source);
            counters.set_peak(0.0);
            try_emit_status(
                &self.status_sender,
                &counters,
                AudioCaptureStatus {
                    source,
                    kind: AudioCaptureStatusKind::Stopped,
                },
            );
        }
        self.stopped = true;
    }
}

fn resolve_explicit_or_default<T>(
    requested: Option<&str>,
    source: AudioSourceId,
    resolve_explicit: impl FnOnce(&str) -> Result<T, AudioCaptureError>,
    resolve_default: impl FnOnce() -> Result<T, AudioCaptureError>,
) -> Result<T, AudioCaptureError> {
    let Some(device_id) = requested else {
        return resolve_default();
    };
    if device_id.is_empty() {
        return Err(AudioCaptureError::InvalidDeviceId {
            source,
            reason: "empty",
        });
    }
    if device_id.len() > MAX_DEVICE_ID_LENGTH {
        return Err(AudioCaptureError::InvalidDeviceId {
            source,
            reason: "too long",
        });
    }
    if device_id.chars().any(char::is_control) {
        return Err(AudioCaptureError::InvalidDeviceId {
            source,
            reason: "contains control characters",
        });
    }
    resolve_explicit(device_id)
}

impl Drop for AudioCapture {
    fn drop(&mut self) {
        self.stop_inner();
    }
}

fn try_emit_status(
    sender: &SyncSender<AudioCaptureStatus>,
    counters: &SourceCounters,
    status: AudioCaptureStatus,
) {
    if sender.try_send(status).is_err() {
        counters.dropped_statuses.fetch_add(1, Ordering::Relaxed);
    }
}

#[cfg(any(windows, test))]
fn sanitize_f32(sample: f32) -> f32 {
    if sample.is_finite() {
        sample.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

#[cfg(any(windows, test))]
fn i16_to_f32(sample: i16) -> f32 {
    f32::from(sample) / 32_768.0
}

#[cfg(any(windows, test))]
fn u16_to_f32(sample: u16) -> f32 {
    (f32::from(sample) - 32_768.0) / 32_768.0
}

#[cfg(any(windows, test))]
fn packet_peak(samples: &[f32]) -> f32 {
    samples
        .iter()
        .copied()
        .map(sanitize_f32)
        .map(f32::abs)
        .fold(0.0, f32::max)
}

#[cfg(any(windows, test))]
#[allow(clippy::too_many_arguments)]
fn publish_samples<T: Copy>(
    input: &[T],
    convert: fn(T) -> f32,
    source: AudioSourceId,
    sample_rate: u32,
    channels: u16,
    packet_sender: &SyncSender<RawAudioPacket>,
    status_sender: &SyncSender<AudioCaptureStatus>,
    counters: &SourceCounters,
) {
    let samples: Vec<f32> = input.iter().copied().map(convert).collect();
    let packet = RawAudioPacket {
        source,
        sample_rate,
        channels,
        samples,
    };

    let frames = u64::try_from(packet.frame_count()).unwrap_or(u64::MAX);
    counters
        .captured_frames
        .fetch_add(frames, Ordering::Relaxed);
    counters.set_peak(packet_peak(&packet.samples));

    let drop_reason = match packet_sender.try_send(packet) {
        Ok(()) => return,
        Err(TrySendError::Full(_)) => AudioPacketDropReason::QueueFull,
        Err(TrySendError::Disconnected(_)) => AudioPacketDropReason::ReceiverDisconnected,
    };
    let total_dropped_packets = counters
        .dropped_packets
        .fetch_add(1, Ordering::Relaxed)
        .wrapping_add(1);
    try_emit_status(
        status_sender,
        counters,
        AudioCaptureStatus {
            source,
            kind: AudioCaptureStatusKind::PacketDropped {
                total_dropped_packets,
                reason: drop_reason,
            },
        },
    );
}

#[cfg(any(windows, test))]
fn report_stream_error(
    source: AudioSourceId,
    message: String,
    status_sender: &SyncSender<AudioCaptureStatus>,
    counters: &SourceCounters,
) {
    counters.stream_errors.fetch_add(1, Ordering::Relaxed);
    try_emit_status(
        status_sender,
        counters,
        AudioCaptureStatus {
            source,
            kind: AudioCaptureStatusKind::StreamError { message },
        },
    );
}

#[cfg(windows)]
mod platform {
    use super::*;
    use cpal::{
        Device, SampleFormat, Stream, SupportedStreamConfig,
        traits::{DeviceTrait, HostTrait, StreamTrait},
    };

    struct Endpoints {
        system_output: Device,
        system_output_config: SupportedStreamConfig,
        microphone: Device,
        microphone_config: SupportedStreamConfig,
        preflight: AudioCapturePreflight,
    }

    pub(super) fn preflight_default_devices() -> Result<AudioCapturePreflight, AudioCaptureError> {
        Ok(query_endpoints(AudioDeviceSelection::default())?.preflight)
    }

    pub(super) fn device_inventory() -> Result<AudioDeviceInventory, AudioCaptureError> {
        let host = cpal::default_host();
        let default_system_output_id = host
            .default_output_device()
            .and_then(|device| device.id().ok())
            .map(|device_id| device_id.to_string());
        let default_microphone_id = host
            .default_input_device()
            .and_then(|device| device.id().ok())
            .map(|device_id| device_id.to_string());

        let system_outputs = host
            .output_devices()
            .map_err(|error| AudioCaptureError::DeviceQueryFailed {
                source: AudioSourceId::SystemOutput,
                operation: "available devices",
                message: error.to_string(),
            })?
            .filter_map(|device| {
                inventory_item(
                    device,
                    AudioSourceId::SystemOutput,
                    default_system_output_id.as_deref(),
                )
            })
            .collect::<Vec<_>>();
        let microphones = host
            .input_devices()
            .map_err(|error| AudioCaptureError::DeviceQueryFailed {
                source: AudioSourceId::Microphone,
                operation: "available devices",
                message: error.to_string(),
            })?
            .filter_map(|device| {
                inventory_item(
                    device,
                    AudioSourceId::Microphone,
                    default_microphone_id.as_deref(),
                )
            })
            .collect::<Vec<_>>();

        Ok(AudioDeviceInventory {
            system_outputs: sorted_inventory(system_outputs),
            microphones: sorted_inventory(microphones),
        })
    }

    pub(super) fn start(
        options: AudioCaptureOptions,
        selection: AudioDeviceSelection,
    ) -> Result<(AudioCapture, AudioCaptureOutput), AudioCaptureError> {
        let endpoints = query_endpoints(selection)?;
        let (packet_sender, packets) = sync_channel(options.packet_queue_capacity);
        let (status_sender, statuses) = sync_channel(options.status_queue_capacity);
        let metrics = AudioCaptureMetrics::default();

        let system_output_stream = build_stream(
            &endpoints.system_output,
            &endpoints.system_output_config,
            AudioSourceId::SystemOutput,
            &packet_sender,
            &status_sender,
            &metrics,
        )?;
        let microphone_stream = build_stream(
            &endpoints.microphone,
            &endpoints.microphone_config,
            AudioSourceId::Microphone,
            &packet_sender,
            &status_sender,
            &metrics,
        )?;

        play_stream(&system_output_stream, AudioSourceId::SystemOutput)?;
        play_stream(&microphone_stream, AudioSourceId::Microphone)?;

        for source in [AudioSourceId::SystemOutput, AudioSourceId::Microphone] {
            let counters = metrics.counters(source);
            try_emit_status(
                &status_sender,
                &counters,
                AudioCaptureStatus {
                    source,
                    kind: AudioCaptureStatusKind::Started,
                },
            );
        }

        let capture = AudioCapture {
            streams: Some(vec![system_output_stream, microphone_stream]),
            active_sources: vec![AudioSourceId::SystemOutput, AudioSourceId::Microphone],
            status_sender,
            metrics: metrics.clone(),
            stopped: false,
        };
        let output = AudioCaptureOutput {
            packets,
            statuses,
            metrics,
            preflight: endpoints.preflight,
        };
        Ok((capture, output))
    }

    fn query_endpoints(selection: AudioDeviceSelection) -> Result<Endpoints, AudioCaptureError> {
        let host = cpal::default_host();
        let (system_output, system_output_config) = query_endpoint(
            &host,
            selection.system_output_device_id.as_deref(),
            AudioSourceId::SystemOutput,
        )?;
        let (microphone, microphone_config) = query_endpoint(
            &host,
            selection.microphone_device_id.as_deref(),
            AudioSourceId::Microphone,
        )?;

        let system_output_preflight = describe_device(
            &system_output,
            &system_output_config,
            AudioSourceId::SystemOutput,
        )?;
        let microphone_preflight =
            describe_device(&microphone, &microphone_config, AudioSourceId::Microphone)?;

        Ok(Endpoints {
            system_output,
            system_output_config,
            microphone,
            microphone_config,
            preflight: AudioCapturePreflight {
                system_output: system_output_preflight,
                microphone: microphone_preflight,
            },
        })
    }

    fn query_endpoint(
        host: &cpal::Host,
        requested: Option<&str>,
        source: AudioSourceId,
    ) -> Result<(Device, SupportedStreamConfig), AudioCaptureError> {
        resolve_explicit_or_default(
            requested,
            source,
            |device_id| query_selected_endpoint(host, device_id, source),
            || query_default_endpoint(host, source),
        )
    }

    fn query_default_endpoint(
        host: &cpal::Host,
        source: AudioSourceId,
    ) -> Result<(Device, SupportedStreamConfig), AudioCaptureError> {
        let device = match source {
            AudioSourceId::SystemOutput => host.default_output_device(),
            AudioSourceId::Microphone => host.default_input_device(),
        }
        .ok_or(AudioCaptureError::DefaultDeviceUnavailable { source })?;
        let config = match source {
            AudioSourceId::SystemOutput => device.default_output_config(),
            AudioSourceId::Microphone => device.default_input_config(),
        }
        .map_err(|error| AudioCaptureError::DeviceQueryFailed {
            source,
            operation: "default stream config",
            message: error.to_string(),
        })?;
        Ok((device, config))
    }

    fn query_selected_endpoint(
        host: &cpal::Host,
        serialized_id: &str,
        source: AudioSourceId,
    ) -> Result<(Device, SupportedStreamConfig), AudioCaptureError> {
        let device_id = serialized_id.parse::<cpal::DeviceId>().map_err(|_| {
            AudioCaptureError::InvalidDeviceId {
                source,
                reason: "malformed",
            }
        })?;
        let device = host
            .device_by_id(&device_id)
            .ok_or(AudioCaptureError::SelectedDeviceUnavailable { source })?;
        let role_matches = match source {
            AudioSourceId::SystemOutput => device.supports_output(),
            AudioSourceId::Microphone => device.supports_input(),
        };
        if !role_matches {
            return Err(AudioCaptureError::SelectedDeviceRoleMismatch { source });
        }
        let config = match source {
            AudioSourceId::SystemOutput => device.default_output_config(),
            AudioSourceId::Microphone => device.default_input_config(),
        }
        .map_err(|error| AudioCaptureError::SelectedDeviceOpenFailed {
            source,
            message: error.to_string(),
        })?;
        Ok((device, config))
    }

    fn inventory_item(
        device: Device,
        source: AudioSourceId,
        default_id: Option<&str>,
    ) -> Option<AudioDeviceInventoryItem> {
        let config = match source {
            AudioSourceId::SystemOutput => device.default_output_config(),
            AudioSourceId::Microphone => device.default_input_config(),
        }
        .ok()?;
        supported_sample_format(source, config.sample_format()).ok()?;
        let device_id = device.id().ok()?.to_string();
        if device_id.is_empty()
            || device_id.len() > MAX_DEVICE_ID_LENGTH
            || device_id.chars().any(char::is_control)
        {
            return None;
        }
        let name = device.description().ok()?.name().trim().to_owned();
        if name.is_empty() {
            return None;
        }
        Some(AudioDeviceInventoryItem {
            is_default: default_id == Some(device_id.as_str()),
            device_id,
            name,
        })
    }

    fn sorted_inventory(mut items: Vec<AudioDeviceInventoryItem>) -> Vec<AudioDeviceInventoryItem> {
        items.sort_by(|left, right| {
            left.name
                .to_lowercase()
                .cmp(&right.name.to_lowercase())
                .then_with(|| left.device_id.cmp(&right.device_id))
        });
        items
    }

    fn describe_device(
        device: &Device,
        config: &SupportedStreamConfig,
        source: AudioSourceId,
    ) -> Result<AudioDevicePreflight, AudioCaptureError> {
        let name = device
            .description()
            .map_err(|error| AudioCaptureError::DeviceQueryFailed {
                source,
                operation: "name",
                message: error.to_string(),
            })?
            .name()
            .to_owned();
        Ok(AudioDevicePreflight {
            source,
            device_id: device
                .id()
                .map_err(|error| AudioCaptureError::DeviceQueryFailed {
                    source,
                    operation: "id",
                    message: error.to_string(),
                })?
                .to_string(),
            name,
            sample_rate: config.sample_rate(),
            channels: config.channels(),
            sample_format: supported_sample_format(source, config.sample_format())?,
        })
    }

    fn supported_sample_format(
        source: AudioSourceId,
        sample_format: SampleFormat,
    ) -> Result<AudioSampleFormat, AudioCaptureError> {
        match sample_format {
            SampleFormat::F32 => Ok(AudioSampleFormat::F32),
            SampleFormat::I16 => Ok(AudioSampleFormat::I16),
            SampleFormat::U16 => Ok(AudioSampleFormat::U16),
            unsupported => Err(AudioCaptureError::UnsupportedSampleFormat {
                source,
                format: format!("{unsupported:?}"),
            }),
        }
    }

    fn build_stream(
        device: &Device,
        config: &SupportedStreamConfig,
        source: AudioSourceId,
        packet_sender: &SyncSender<RawAudioPacket>,
        status_sender: &SyncSender<AudioCaptureStatus>,
        metrics: &AudioCaptureMetrics,
    ) -> Result<Stream, AudioCaptureError> {
        match supported_sample_format(source, config.sample_format())? {
            AudioSampleFormat::F32 => build_typed_stream::<f32>(
                device,
                config,
                source,
                sanitize_f32,
                packet_sender,
                status_sender,
                metrics,
            ),
            AudioSampleFormat::I16 => build_typed_stream::<i16>(
                device,
                config,
                source,
                i16_to_f32,
                packet_sender,
                status_sender,
                metrics,
            ),
            AudioSampleFormat::U16 => build_typed_stream::<u16>(
                device,
                config,
                source,
                u16_to_f32,
                packet_sender,
                status_sender,
                metrics,
            ),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn build_typed_stream<T>(
        device: &Device,
        config: &SupportedStreamConfig,
        source: AudioSourceId,
        convert: fn(T) -> f32,
        packet_sender: &SyncSender<RawAudioPacket>,
        status_sender: &SyncSender<AudioCaptureStatus>,
        metrics: &AudioCaptureMetrics,
    ) -> Result<Stream, AudioCaptureError>
    where
        T: cpal::SizedSample + Copy + 'static,
    {
        let stream_config = config.config();
        let sample_rate = stream_config.sample_rate;
        let channels = stream_config.channels;
        let packet_sender = packet_sender.clone();
        let data_status_sender = status_sender.clone();
        let error_status_sender = status_sender.clone();
        let data_counters = metrics.counters(source);
        let error_counters = Arc::clone(&data_counters);

        device
            .build_input_stream::<T, _, _>(
                &stream_config,
                move |samples, _callback_info| {
                    publish_samples(
                        samples,
                        convert,
                        source,
                        sample_rate,
                        channels,
                        &packet_sender,
                        &data_status_sender,
                        &data_counters,
                    );
                },
                move |error| {
                    report_stream_error(
                        source,
                        error.to_string(),
                        &error_status_sender,
                        &error_counters,
                    );
                },
                None,
            )
            .map_err(|error| AudioCaptureError::StreamBuildFailed {
                source,
                message: error.to_string(),
            })
    }

    fn play_stream(stream: &Stream, source: AudioSourceId) -> Result<(), AudioCaptureError> {
        stream
            .play()
            .map_err(|error| AudioCaptureError::StreamStartFailed {
                source,
                message: error.to_string(),
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::TryRecvError;

    fn assert_close(actual: f32, expected: f32) {
        assert!((actual - expected).abs() < 0.000_001);
    }

    #[test]
    fn supported_samples_convert_to_normalized_f32() {
        assert_eq!(sanitize_f32(f32::NAN), 0.0);
        assert_eq!(sanitize_f32(f32::INFINITY), 0.0);
        assert_eq!(sanitize_f32(-2.0), -1.0);
        assert_eq!(sanitize_f32(2.0), 1.0);

        assert_eq!(i16_to_f32(i16::MIN), -1.0);
        assert_eq!(i16_to_f32(0), 0.0);
        assert_close(i16_to_f32(i16::MAX), 32_767.0 / 32_768.0);

        assert_eq!(u16_to_f32(u16::MIN), -1.0);
        assert_eq!(u16_to_f32(32_768), 0.0);
        assert_close(u16_to_f32(u16::MAX), 32_767.0 / 32_768.0);
    }

    #[test]
    fn peak_is_absolute_finite_and_bounded() {
        assert_eq!(packet_peak(&[]), 0.0);
        assert_eq!(packet_peak(&[f32::NAN, -0.25, 0.75]), 0.75);
        assert_eq!(packet_peak(&[-2.0, 0.5]), 1.0);
    }

    #[test]
    fn packet_queue_drop_updates_metrics_and_emits_bounded_status() {
        let (packet_sender, packets) = sync_channel(1);
        let (status_sender, statuses) = sync_channel(1);
        let counters = SourceCounters::default();

        publish_samples(
            &[0_i16, i16::MAX, i16::MIN, 0],
            i16_to_f32,
            AudioSourceId::Microphone,
            48_000,
            2,
            &packet_sender,
            &status_sender,
            &counters,
        );
        assert_eq!(counters.snapshot().peak, 1.0);
        publish_samples(
            &[0_i16, 0, 0, 0],
            i16_to_f32,
            AudioSourceId::Microphone,
            48_000,
            2,
            &packet_sender,
            &status_sender,
            &counters,
        );

        let packet = packets.try_recv().expect("first packet should be queued");
        assert_eq!(packet.frame_count(), 2);
        assert_eq!(packet.samples.len(), 4);
        assert_eq!(
            statuses.try_recv().expect("drop status should be queued"),
            AudioCaptureStatus {
                source: AudioSourceId::Microphone,
                kind: AudioCaptureStatusKind::PacketDropped {
                    total_dropped_packets: 1,
                    reason: AudioPacketDropReason::QueueFull,
                },
            }
        );
        assert_eq!(statuses.try_recv(), Err(TryRecvError::Empty));

        let stats = counters.snapshot();
        assert_eq!(stats.captured_frames, 4);
        assert_eq!(stats.peak, 0.0);
        assert_eq!(stats.dropped_packets, 1);
        assert_eq!(stats.dropped_statuses, 0);
    }

    #[test]
    fn stream_errors_never_block_when_status_queue_is_full() {
        let (status_sender, statuses) = sync_channel(1);
        let counters = SourceCounters::default();

        report_stream_error(
            AudioSourceId::SystemOutput,
            "first".to_owned(),
            &status_sender,
            &counters,
        );
        report_stream_error(
            AudioSourceId::SystemOutput,
            "second".to_owned(),
            &status_sender,
            &counters,
        );

        assert_eq!(
            statuses.try_recv().expect("first error should be queued"),
            AudioCaptureStatus {
                source: AudioSourceId::SystemOutput,
                kind: AudioCaptureStatusKind::StreamError {
                    message: "first".to_owned(),
                },
            }
        );
        let stats = counters.snapshot();
        assert_eq!(stats.stream_errors, 2);
        assert_eq!(stats.dropped_statuses, 1);
    }

    #[test]
    fn zero_capacity_options_are_rejected_without_touching_devices() {
        assert_eq!(
            AudioCaptureOptions {
                packet_queue_capacity: 0,
                status_queue_capacity: 1,
            }
            .validate(),
            Err(AudioCaptureError::InvalidQueueCapacity { queue: "packet" })
        );
        assert_eq!(
            AudioCaptureOptions {
                packet_queue_capacity: 1,
                status_queue_capacity: 0,
            }
            .validate(),
            Err(AudioCaptureError::InvalidQueueCapacity { queue: "status" })
        );
    }

    #[test]
    fn missing_device_selection_uses_the_legacy_default() {
        let selected = resolve_explicit_or_default(
            None,
            AudioSourceId::SystemOutput,
            |_| -> Result<u8, AudioCaptureError> {
                panic!("an absent selection must not resolve an explicit device")
            },
            || Ok(7),
        )
        .expect("the default resolver should be used");

        assert_eq!(selected, 7);
    }

    #[test]
    fn invalid_explicit_device_ids_are_rejected_before_resolution() {
        for (device_id, reason) in [
            (String::new(), "empty"),
            ("wasapi:\ninvalid".to_owned(), "contains control characters"),
            ("x".repeat(MAX_DEVICE_ID_LENGTH + 1), "too long"),
        ] {
            let error = resolve_explicit_or_default(
                Some(&device_id),
                AudioSourceId::Microphone,
                |_| -> Result<u8, AudioCaptureError> {
                    panic!("invalid identifiers must not reach device resolution")
                },
                || -> Result<u8, AudioCaptureError> {
                    panic!("an explicit selection must never fall back to the default")
                },
            )
            .expect_err("invalid identifiers must fail");

            assert_eq!(
                error,
                AudioCaptureError::InvalidDeviceId {
                    source: AudioSourceId::Microphone,
                    reason,
                }
            );
        }
    }

    #[test]
    fn explicit_device_resolution_errors_never_fall_back() {
        let error = resolve_explicit_or_default(
            Some("wasapi:missing"),
            AudioSourceId::SystemOutput,
            |_| {
                Err(AudioCaptureError::SelectedDeviceUnavailable {
                    source: AudioSourceId::SystemOutput,
                })
            },
            || -> Result<u8, AudioCaptureError> {
                panic!("an unavailable saved selection must be reselected")
            },
        )
        .expect_err("the explicit resolution error must be preserved");

        assert_eq!(
            error,
            AudioCaptureError::SelectedDeviceUnavailable {
                source: AudioSourceId::SystemOutput,
            }
        );
    }
}
