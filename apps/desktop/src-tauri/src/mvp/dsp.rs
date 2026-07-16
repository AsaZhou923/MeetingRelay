use std::collections::VecDeque;
use std::fmt;

pub const TARGET_SAMPLE_RATE_HZ: u32 = 16_000;
pub const BLOCK_DURATION_MS: u32 = 20;
pub const BLOCK_SAMPLES: usize =
    (TARGET_SAMPLE_RATE_HZ as usize * BLOCK_DURATION_MS as usize) / 1_000;
pub const PREROLL_BLOCKS: usize = 300 / BLOCK_DURATION_MS as usize;
pub const SILENCE_FINALIZE_BLOCKS: usize = 650_usize.div_ceil(BLOCK_DURATION_MS as usize);
pub const INTERIM_BLOCKS: usize = 2_000 / BLOCK_DURATION_MS as usize;
pub const MAX_SEGMENT_BLOCKS: usize = 8_000 / BLOCK_DURATION_MS as usize;
pub const SPEECH_START_BLOCKS: usize = 120 / BLOCK_DURATION_MS as usize;
pub const MINIMUM_SPEECH_BLOCKS: usize = 200 / BLOCK_DURATION_MS as usize;

pub type AudioBlock = [f32; BLOCK_SAMPLES];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DspConfigError {
    ZeroInputRate,
    ZeroChannels,
    InvalidEndpointConfig(&'static str),
}

impl fmt::Display for DspConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ZeroInputRate => formatter.write_str("input sample rate must be positive"),
            Self::ZeroChannels => formatter.write_str("channel count must be positive"),
            Self::InvalidEndpointConfig(field) => {
                write!(formatter, "invalid endpoint configuration: {field}")
            }
        }
    }
}

impl std::error::Error for DspConfigError {}

/// Streaming downmixer and linear resampler with one rational timeline for the
/// lifetime of the stream. Callback boundaries therefore cannot reset or round
/// the resampling phase.
#[derive(Debug)]
pub struct Mono16kResampler {
    input_rate_hz: u64,
    channels: usize,
    partial_frame: Vec<f32>,
    previous_sample: Option<f32>,
    input_frames: u64,
    output_samples: u64,
    next_output_time: u128,
}

impl Mono16kResampler {
    pub fn new(input_rate_hz: u32, channels: usize) -> Result<Self, DspConfigError> {
        if input_rate_hz == 0 {
            return Err(DspConfigError::ZeroInputRate);
        }
        if channels == 0 {
            return Err(DspConfigError::ZeroChannels);
        }

        Ok(Self {
            input_rate_hz: u64::from(input_rate_hz),
            channels,
            partial_frame: Vec::with_capacity(channels),
            previous_sample: None,
            input_frames: 0,
            output_samples: 0,
            next_output_time: 0,
        })
    }

    pub fn input_rate_hz(&self) -> u32 {
        self.input_rate_hz as u32
    }

    pub fn channels(&self) -> usize {
        self.channels
    }

    pub fn input_frames(&self) -> u64 {
        self.input_frames
    }

    pub fn output_samples(&self) -> u64 {
        self.output_samples
    }

    pub fn pending_channel_samples(&self) -> usize {
        self.partial_frame.len()
    }

    /// Appends mono 16 kHz samples to `output`. An incomplete interleaved frame
    /// is retained until a later callback supplies its remaining channels.
    pub fn push_interleaved(&mut self, mut input: &[f32], output: &mut Vec<f32>) {
        if !self.partial_frame.is_empty() {
            let needed = self.channels - self.partial_frame.len();
            let taken = needed.min(input.len());
            self.partial_frame.extend_from_slice(&input[..taken]);
            input = &input[taken..];

            if self.partial_frame.len() == self.channels {
                let mono = downmix_frame(&self.partial_frame);
                self.partial_frame.clear();
                self.push_mono_frame(mono, output);
            } else {
                return;
            }
        }

        let complete_sample_count = (input.len() / self.channels) * self.channels;
        for frame in input[..complete_sample_count].chunks_exact(self.channels) {
            self.push_mono_frame(downmix_frame(frame), output);
        }
        self.partial_frame
            .extend_from_slice(&input[complete_sample_count..]);
    }

    pub fn reset(&mut self) {
        self.partial_frame.clear();
        self.previous_sample = None;
        self.input_frames = 0;
        self.output_samples = 0;
        self.next_output_time = 0;
    }

    fn push_mono_frame(&mut self, sample: f32, output: &mut Vec<f32>) {
        let frame_index = self.input_frames;
        self.input_frames += 1;

        let Some(previous) = self.previous_sample else {
            output.push(sample);
            self.output_samples += 1;
            self.next_output_time += u128::from(self.input_rate_hz);
            self.previous_sample = Some(sample);
            return;
        };

        let target_rate = u128::from(TARGET_SAMPLE_RATE_HZ);
        let left_time = u128::from(frame_index - 1) * target_rate;
        let right_time = u128::from(frame_index) * target_rate;

        while self.next_output_time <= right_time {
            let fraction =
                (self.next_output_time - left_time) as f64 / f64::from(TARGET_SAMPLE_RATE_HZ);
            let interpolated =
                f64::from(previous) + (f64::from(sample) - f64::from(previous)) * fraction;
            output.push(interpolated as f32);
            self.output_samples += 1;
            self.next_output_time += u128::from(self.input_rate_hz);
        }

        self.previous_sample = Some(sample);
    }
}

fn downmix_frame(frame: &[f32]) -> f32 {
    let sum = frame.iter().fold(0.0_f64, |sum, &sample| {
        sum + if sample.is_finite() {
            f64::from(sample)
        } else {
            0.0
        }
    });
    (sum / frame.len() as f64).clamp(-1.0, 1.0) as f32
}

#[derive(Debug)]
pub struct BlockPacketizer {
    pending: AudioBlock,
    pending_len: usize,
}

impl Default for BlockPacketizer {
    fn default() -> Self {
        Self {
            pending: [0.0; BLOCK_SAMPLES],
            pending_len: 0,
        }
    }
}

impl BlockPacketizer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, mut samples: &[f32], output: &mut Vec<AudioBlock>) {
        while !samples.is_empty() {
            let copied = (BLOCK_SAMPLES - self.pending_len).min(samples.len());
            self.pending[self.pending_len..self.pending_len + copied]
                .copy_from_slice(&samples[..copied]);
            self.pending_len += copied;
            samples = &samples[copied..];

            if self.pending_len == BLOCK_SAMPLES {
                output.push(self.pending);
                self.pending = [0.0; BLOCK_SAMPLES];
                self.pending_len = 0;
            }
        }
    }

    /// Emits a final zero-padded block, if necessary. This is intended for a
    /// session stop boundary; normal capture callbacks should call `push` only.
    pub fn flush_padded(&mut self) -> Option<AudioBlock> {
        if self.pending_len == 0 {
            return None;
        }

        let block = self.pending;
        self.pending = [0.0; BLOCK_SAMPLES];
        self.pending_len = 0;
        Some(block)
    }

    pub fn pending_samples(&self) -> usize {
        self.pending_len
    }

    pub fn reset(&mut self) {
        self.pending = [0.0; BLOCK_SAMPLES];
        self.pending_len = 0;
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MixMode {
    Full,
    SystemOnlyDegraded,
    MicrophoneOnlyDegraded,
    Unavailable,
}

impl MixMode {
    pub fn is_degraded(self) -> bool {
        self != Self::Full
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct MixedBlock {
    pub samples: AudioBlock,
    pub peak: f32,
    pub mode: MixMode,
}

pub fn mix_blocks(system: Option<&AudioBlock>, microphone: Option<&AudioBlock>) -> MixedBlock {
    let mode = match (system, microphone) {
        (Some(_), Some(_)) => MixMode::Full,
        (Some(_), None) => MixMode::SystemOnlyDegraded,
        (None, Some(_)) => MixMode::MicrophoneOnlyDegraded,
        (None, None) => MixMode::Unavailable,
    };

    let mut samples = [0.0; BLOCK_SAMPLES];
    let mut peak = 0.0_f32;
    for index in 0..BLOCK_SAMPLES {
        let system_sample = system.map_or(0.0, |block| finite_sample(block[index]));
        let microphone_sample = microphone.map_or(0.0, |block| finite_sample(block[index]));
        let sample = (system_sample + microphone_sample).clamp(-1.0, 1.0);
        samples[index] = sample;
        peak = peak.max(sample.abs());
    }

    MixedBlock {
        samples,
        peak,
        mode,
    }
}

pub fn normalized_peak(samples: &[f32]) -> f32 {
    samples.iter().fold(0.0_f32, |peak, &sample| {
        peak.max(finite_sample(sample).abs().min(1.0))
    })
}

pub fn rms_energy(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }

    let sum_of_squares = samples.iter().fold(0.0_f64, |sum, &sample| {
        let sample = f64::from(finite_sample(sample));
        sum + sample * sample
    });
    (sum_of_squares / samples.len() as f64).sqrt() as f32
}

fn finite_sample(sample: f32) -> f32 {
    if sample.is_finite() { sample } else { 0.0 }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EndpointConfig {
    pub speech_rms_threshold: f32,
    pub speech_start_blocks: usize,
    pub minimum_speech_blocks: usize,
    pub preroll_blocks: usize,
    pub silence_finalize_blocks: usize,
    pub interim_blocks: usize,
    pub max_segment_blocks: usize,
}

impl Default for EndpointConfig {
    fn default() -> Self {
        Self {
            // Keep quiet loopback speech audible; the consecutive-onset and
            // minimum-speech windows below reject short laptop-fan spikes.
            speech_rms_threshold: 0.015,
            speech_start_blocks: SPEECH_START_BLOCKS,
            minimum_speech_blocks: MINIMUM_SPEECH_BLOCKS,
            preroll_blocks: PREROLL_BLOCKS,
            silence_finalize_blocks: SILENCE_FINALIZE_BLOCKS,
            interim_blocks: INTERIM_BLOCKS,
            max_segment_blocks: MAX_SEGMENT_BLOCKS,
        }
    }
}

impl EndpointConfig {
    fn validate(self) -> Result<Self, DspConfigError> {
        if !self.speech_rms_threshold.is_finite() || self.speech_rms_threshold < 0.0 {
            return Err(DspConfigError::InvalidEndpointConfig(
                "speech_rms_threshold",
            ));
        }
        if self.speech_start_blocks == 0 {
            return Err(DspConfigError::InvalidEndpointConfig("speech_start_blocks"));
        }
        if self.minimum_speech_blocks < self.speech_start_blocks {
            return Err(DspConfigError::InvalidEndpointConfig(
                "minimum_speech_blocks",
            ));
        }
        if self.preroll_blocks == 0 {
            return Err(DspConfigError::InvalidEndpointConfig("preroll_blocks"));
        }
        if self.silence_finalize_blocks == 0 {
            return Err(DspConfigError::InvalidEndpointConfig(
                "silence_finalize_blocks",
            ));
        }
        if self.interim_blocks == 0 {
            return Err(DspConfigError::InvalidEndpointConfig("interim_blocks"));
        }
        if self.max_segment_blocks < self.preroll_blocks
            || self.max_segment_blocks < self.interim_blocks
        {
            return Err(DspConfigError::InvalidEndpointConfig("max_segment_blocks"));
        }
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FinalReason {
    Silence,
    MaxDuration,
    Stop,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AudioSegment {
    pub samples: Vec<f32>,
    pub started_at_sample: u64,
    pub ended_at_sample: u64,
}

impl AudioSegment {
    pub fn duration_samples(&self) -> u64 {
        self.ended_at_sample - self.started_at_sample
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum SegmentEvent {
    Interim(AudioSegment),
    Final {
        segment: AudioSegment,
        reason: FinalReason,
    },
}

#[derive(Clone, Debug)]
struct PrerollBlock {
    started_at_sample: u64,
    samples: AudioBlock,
}

#[derive(Debug)]
struct ActiveSegment {
    samples: Vec<f32>,
    started_at_sample: u64,
    silent_blocks: usize,
    speech_blocks: usize,
    next_interim_sample_count: usize,
}

/// A low-cost energy endpoint detector. It deliberately operates on fixed
/// 20 ms blocks so every threshold maps to a deterministic audio timeline.
#[derive(Debug)]
pub struct EnergyEndpointSegmenter {
    config: EndpointConfig,
    preroll: VecDeque<PrerollBlock>,
    active: Option<ActiveSegment>,
    speech_run_blocks: usize,
    processed_samples: u64,
}

impl Default for EnergyEndpointSegmenter {
    fn default() -> Self {
        Self::new()
    }
}

impl EnergyEndpointSegmenter {
    pub fn new() -> Self {
        Self::with_config(EndpointConfig::default())
            .expect("the built-in endpoint configuration must be valid")
    }

    pub fn with_config(config: EndpointConfig) -> Result<Self, DspConfigError> {
        let config = config.validate()?;
        Ok(Self {
            config,
            preroll: VecDeque::with_capacity(config.preroll_blocks),
            active: None,
            speech_run_blocks: 0,
            processed_samples: 0,
        })
    }

    pub fn config(&self) -> EndpointConfig {
        self.config
    }

    pub fn processed_samples(&self) -> u64 {
        self.processed_samples
    }

    pub fn is_active(&self) -> bool {
        self.active.is_some()
    }

    pub fn push_block(&mut self, block: &AudioBlock) -> Option<SegmentEvent> {
        let block_start = self.processed_samples;
        self.processed_samples += BLOCK_SAMPLES as u64;
        let speech = rms_energy(block) >= self.config.speech_rms_threshold;
        self.remember_preroll(block_start, block);

        if self.active.is_none() {
            if speech {
                self.speech_run_blocks = self.speech_run_blocks.saturating_add(1);
                if self.speech_run_blocks >= self.config.speech_start_blocks {
                    self.start_from_preroll();
                    self.speech_run_blocks = 0;
                }
            } else {
                self.speech_run_blocks = 0;
            }
            return None;
        }

        let active = self
            .active
            .as_mut()
            .expect("the active segment was checked above");
        active.samples.extend_from_slice(block);
        if speech {
            active.silent_blocks = 0;
            active.speech_blocks = active.speech_blocks.saturating_add(1);
        } else {
            active.silent_blocks += 1;
        }

        if active.samples.len() >= self.config.max_segment_blocks * BLOCK_SAMPLES {
            return self.finalize(FinalReason::MaxDuration);
        }
        if active.silent_blocks >= self.config.silence_finalize_blocks {
            return self.finalize(FinalReason::Silence);
        }
        if active.samples.len() >= active.next_interim_sample_count {
            active.next_interim_sample_count += self.config.interim_blocks * BLOCK_SAMPLES;
            return Some(SegmentEvent::Interim(AudioSegment {
                samples: active.samples.clone(),
                started_at_sample: active.started_at_sample,
                ended_at_sample: self.processed_samples,
            }));
        }

        None
    }

    /// Finalizes the active speech segment at a recording stop boundary. Pure
    /// preroll/noise is intentionally discarded.
    pub fn flush_stop(&mut self) -> Option<SegmentEvent> {
        let event = self.finalize(FinalReason::Stop);
        self.preroll.clear();
        self.speech_run_blocks = 0;
        event
    }

    pub fn reset(&mut self) {
        self.preroll.clear();
        self.active = None;
        self.speech_run_blocks = 0;
        self.processed_samples = 0;
    }

    fn remember_preroll(&mut self, started_at_sample: u64, block: &AudioBlock) {
        if self.preroll.len() == self.config.preroll_blocks {
            self.preroll.pop_front();
        }
        self.preroll.push_back(PrerollBlock {
            started_at_sample,
            samples: *block,
        });
    }

    fn start_from_preroll(&mut self) {
        let started_at_sample = self
            .preroll
            .front()
            .map_or(self.processed_samples, |block| block.started_at_sample);
        let mut samples = Vec::with_capacity(self.config.max_segment_blocks * BLOCK_SAMPLES);
        for block in &self.preroll {
            samples.extend_from_slice(&block.samples);
        }
        self.active = Some(ActiveSegment {
            samples,
            started_at_sample,
            silent_blocks: 0,
            speech_blocks: self.config.speech_start_blocks,
            next_interim_sample_count: self.config.interim_blocks * BLOCK_SAMPLES,
        });
    }

    fn finalize(&mut self, reason: FinalReason) -> Option<SegmentEvent> {
        let active = self.active.take()?;
        if active.speech_blocks < self.config.minimum_speech_blocks {
            return None;
        }
        Some(SegmentEvent::Final {
            segment: AudioSegment {
                samples: active.samples,
                started_at_sample: active.started_at_sample,
                ended_at_sample: self.processed_samples,
            },
            reason,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn expected_streaming_outputs(input_frames: u64, input_rate_hz: u32) -> u64 {
        if input_frames == 0 {
            0
        } else {
            ((u128::from(input_frames - 1) * u128::from(TARGET_SAMPLE_RATE_HZ)
                / u128::from(input_rate_hz))
                + 1) as u64
        }
    }

    fn interleaved_signal(frames: usize, channels: usize) -> Vec<f32> {
        let mut samples = Vec::with_capacity(frames * channels);
        for frame in 0..frames {
            for channel in 0..channels {
                let value = ((frame * 17 + channel * 31) % 2_000) as f32 / 1_000.0 - 1.0;
                samples.push(value);
            }
        }
        samples
    }

    fn constant_block(value: f32) -> AudioBlock {
        [value; BLOCK_SAMPLES]
    }

    fn final_event(event: Option<SegmentEvent>) -> (AudioSegment, FinalReason) {
        match event {
            Some(SegmentEvent::Final { segment, reason }) => (segment, reason),
            other => panic!("expected final event, got {other:?}"),
        }
    }

    #[test]
    fn resampler_keeps_exact_48k_cumulative_timeline_across_odd_callbacks() {
        let channels = 2;
        let frames = 48_000 * 3;
        let input = interleaved_signal(frames, channels);
        let chunk_sizes = [1, 959, 2_047, 17, 4_800, 3, 11_111];
        let mut resampler = Mono16kResampler::new(48_000, channels).unwrap();
        let mut output = Vec::new();
        let mut offset = 0;
        let mut chunk_index = 0;

        while offset < input.len() {
            let end = (offset + chunk_sizes[chunk_index % chunk_sizes.len()]).min(input.len());
            resampler.push_interleaved(&input[offset..end], &mut output);
            offset = end;
            chunk_index += 1;

            let complete_frames = (offset / channels) as u64;
            assert_eq!(resampler.input_frames(), complete_frames);
            assert_eq!(
                resampler.output_samples(),
                expected_streaming_outputs(complete_frames, 48_000)
            );
        }

        assert_eq!(resampler.output_samples(), 48_000);
        assert_eq!(output.len(), 48_000);
        assert_eq!(resampler.pending_channel_samples(), 0);
    }

    #[test]
    fn resampler_keeps_exact_44k1_cumulative_timeline_without_rounding_drift() {
        let channels = 3;
        let frames = 44_100 * 4;
        let input = interleaved_signal(frames, channels);
        let chunk_sizes = [7, 1_337, 44, 8_191, 5, 3_000];
        let mut resampler = Mono16kResampler::new(44_100, channels).unwrap();
        let mut output = Vec::new();
        let mut offset = 0;
        let mut chunk_index = 0;

        while offset < input.len() {
            let end = (offset + chunk_sizes[chunk_index % chunk_sizes.len()]).min(input.len());
            resampler.push_interleaved(&input[offset..end], &mut output);
            offset = end;
            chunk_index += 1;

            let complete_frames = (offset / channels) as u64;
            assert_eq!(
                resampler.output_samples(),
                expected_streaming_outputs(complete_frames, 44_100)
            );
        }

        assert_eq!(resampler.input_frames(), frames as u64);
        assert_eq!(resampler.output_samples(), 64_000);
        assert_eq!(output.len(), 64_000);
    }

    #[test]
    fn resampler_output_is_independent_of_callback_and_frame_boundaries() {
        let channels = 3;
        let input = interleaved_signal(12_345, channels);
        let mut whole = Mono16kResampler::new(44_100, channels).unwrap();
        let mut whole_output = Vec::new();
        whole.push_interleaved(&input, &mut whole_output);

        let mut chunked = Mono16kResampler::new(44_100, channels).unwrap();
        let mut chunked_output = Vec::new();
        let mut offset = 0;
        for size in [1, 2, 4, 19, 2_003, 5, 9_999].into_iter().cycle() {
            if offset == input.len() {
                break;
            }
            let end = (offset + size).min(input.len());
            chunked.push_interleaved(&input[offset..end], &mut chunked_output);
            offset = end;
        }

        assert_eq!(chunked.pending_channel_samples(), 0);
        assert_eq!(whole_output, chunked_output);
    }

    #[test]
    fn resampler_validates_configuration_and_sanitizes_downmix_input() {
        assert_eq!(
            Mono16kResampler::new(0, 2).unwrap_err(),
            DspConfigError::ZeroInputRate
        );
        assert_eq!(
            Mono16kResampler::new(48_000, 0).unwrap_err(),
            DspConfigError::ZeroChannels
        );

        let mut resampler = Mono16kResampler::new(16_000, 2).unwrap();
        let mut output = Vec::new();
        resampler.push_interleaved(&[f32::NAN, 0.5, 4.0, 4.0], &mut output);
        assert_eq!(output, vec![0.25, 1.0]);
    }

    #[test]
    fn packetizer_preserves_samples_and_only_pads_at_explicit_flush() {
        let input: Vec<f32> = (0..(BLOCK_SAMPLES * 2 + 17))
            .map(|sample| sample as f32)
            .collect();
        let mut packetizer = BlockPacketizer::new();
        let mut blocks = Vec::new();
        packetizer.push(&input[..31], &mut blocks);
        packetizer.push(&input[31..633], &mut blocks);
        packetizer.push(&input[633..], &mut blocks);

        assert_eq!(blocks.len(), 2);
        assert_eq!(&blocks[0][..], &input[..BLOCK_SAMPLES]);
        assert_eq!(&blocks[1][..], &input[BLOCK_SAMPLES..BLOCK_SAMPLES * 2]);
        assert_eq!(packetizer.pending_samples(), 17);

        let padded = packetizer.flush_padded().unwrap();
        assert_eq!(&padded[..17], &input[BLOCK_SAMPLES * 2..]);
        assert!(padded[17..].iter().all(|sample| *sample == 0.0));
        assert_eq!(packetizer.pending_samples(), 0);
        assert!(packetizer.flush_padded().is_none());
    }

    #[test]
    fn mixer_saturates_dual_source_and_reports_single_source_degradation() {
        let mut system = constant_block(0.8);
        let mut microphone = constant_block(0.6);
        system[1] = -0.8;
        microphone[1] = -0.5;
        system[2] = f32::NAN;

        let mixed = mix_blocks(Some(&system), Some(&microphone));
        assert_eq!(mixed.mode, MixMode::Full);
        assert!(!mixed.mode.is_degraded());
        assert_eq!(mixed.samples[0], 1.0);
        assert_eq!(mixed.samples[1], -1.0);
        assert_eq!(mixed.samples[2], 0.6);
        assert_eq!(mixed.peak, 1.0);

        let system_only = mix_blocks(Some(&system), None);
        assert_eq!(system_only.mode, MixMode::SystemOnlyDegraded);
        assert!(system_only.mode.is_degraded());
        assert_eq!(system_only.samples[0], 0.8);
        assert_eq!(system_only.samples[2], 0.0);

        let microphone_only = mix_blocks(None, Some(&microphone));
        assert_eq!(microphone_only.mode, MixMode::MicrophoneOnlyDegraded);
        assert_eq!(microphone_only.samples[0], 0.6);

        let unavailable = mix_blocks(None, None);
        assert_eq!(unavailable.mode, MixMode::Unavailable);
        assert_eq!(unavailable.peak, 0.0);
        assert!(unavailable.samples.iter().all(|sample| *sample == 0.0));
    }

    #[test]
    fn peak_and_rms_are_finite_and_normalized_for_metering() {
        assert_eq!(normalized_peak(&[-2.0, 0.5, f32::NAN]), 1.0);
        assert_eq!(normalized_peak(&[]), 0.0);
        assert!((rms_energy(&[0.5, -0.5, f32::INFINITY]) - 0.408_248_3).abs() < 1e-6);
        assert_eq!(rms_energy(&[]), 0.0);
    }

    #[test]
    fn endpoint_includes_300ms_preroll_and_finalizes_after_about_650ms_silence() {
        let mut segmenter = EnergyEndpointSegmenter::new();
        let silence = constant_block(0.0);
        let speech = constant_block(0.2);

        for _ in 0..20 {
            assert!(segmenter.push_block(&silence).is_none());
        }
        for _ in 0..MINIMUM_SPEECH_BLOCKS {
            assert!(segmenter.push_block(&speech).is_none());
        }
        assert!(segmenter.is_active());
        for _ in 0..(SILENCE_FINALIZE_BLOCKS - 1) {
            assert!(segmenter.push_block(&silence).is_none());
        }

        let (segment, reason) = final_event(segmenter.push_block(&silence));
        assert_eq!(reason, FinalReason::Silence);
        assert_eq!(segment.started_at_sample, 11 * BLOCK_SAMPLES as u64);
        assert_eq!(segment.ended_at_sample, 63 * BLOCK_SAMPLES as u64);
        assert_eq!(
            segment.samples.len(),
            (PREROLL_BLOCKS + MINIMUM_SPEECH_BLOCKS - SPEECH_START_BLOCKS
                + SILENCE_FINALIZE_BLOCKS)
                * BLOCK_SAMPLES
        );
        assert_eq!(segment.duration_samples(), segment.samples.len() as u64);
        assert!(!segmenter.is_active());
    }

    #[test]
    fn endpoint_emits_interim_snapshots_every_two_seconds() {
        let mut segmenter = EnergyEndpointSegmenter::new();
        let speech = constant_block(0.2);
        let mut interims = Vec::new();

        for _ in 0..(INTERIM_BLOCKS * 2) {
            if let Some(SegmentEvent::Interim(segment)) = segmenter.push_block(&speech) {
                interims.push(segment);
            }
        }

        assert_eq!(interims.len(), 2);
        assert_eq!(interims[0].samples.len(), INTERIM_BLOCKS * BLOCK_SAMPLES);
        assert_eq!(
            interims[1].samples.len(),
            INTERIM_BLOCKS * 2 * BLOCK_SAMPLES
        );
        assert_eq!(interims[0].started_at_sample, 0);
        assert_eq!(interims[0].ended_at_sample, 32_000);
        assert_eq!(interims[1].ended_at_sample, 64_000);
    }

    #[test]
    fn endpoint_hard_finalizes_at_eight_seconds_and_can_continue() {
        let mut segmenter = EnergyEndpointSegmenter::new();
        let speech = constant_block(0.2);
        let mut final_segment = None;

        for _ in 0..MAX_SEGMENT_BLOCKS {
            if let Some(SegmentEvent::Final { segment, reason }) = segmenter.push_block(&speech) {
                final_segment = Some((segment, reason));
            }
        }

        let (segment, reason) = final_segment.expect("eight seconds must finalize");
        assert_eq!(reason, FinalReason::MaxDuration);
        assert_eq!(segment.started_at_sample, 0);
        assert_eq!(segment.ended_at_sample, 128_000);
        assert_eq!(segment.samples.len(), 128_000);
        assert!(!segmenter.is_active());

        for _ in 0..MINIMUM_SPEECH_BLOCKS {
            assert!(segmenter.push_block(&speech).is_none());
        }
        let (continued, reason) = final_event(segmenter.flush_stop());
        assert_eq!(reason, FinalReason::Stop);
        assert_eq!(
            continued.samples.len(),
            (PREROLL_BLOCKS + MINIMUM_SPEECH_BLOCKS - SPEECH_START_BLOCKS) * BLOCK_SAMPLES
        );
        assert_eq!(
            continued.started_at_sample,
            (MAX_SEGMENT_BLOCKS + SPEECH_START_BLOCKS - PREROLL_BLOCKS) as u64
                * BLOCK_SAMPLES as u64
        );
    }

    #[test]
    fn endpoint_stop_flushes_active_speech_once_and_discards_noise_only_preroll() {
        let mut segmenter = EnergyEndpointSegmenter::new();
        let silence = constant_block(0.0);
        let speech = constant_block(0.2);

        for _ in 0..10 {
            segmenter.push_block(&silence);
        }
        for _ in 0..MINIMUM_SPEECH_BLOCKS {
            segmenter.push_block(&speech);
        }

        let (segment, reason) = final_event(segmenter.flush_stop());
        assert_eq!(reason, FinalReason::Stop);
        assert_eq!(segment.started_at_sample, BLOCK_SAMPLES as u64);
        assert_eq!(
            segment.ended_at_sample,
            (10 + MINIMUM_SPEECH_BLOCKS) as u64 * BLOCK_SAMPLES as u64
        );
        assert_eq!(
            segment.samples.len(),
            (PREROLL_BLOCKS + MINIMUM_SPEECH_BLOCKS - SPEECH_START_BLOCKS) * BLOCK_SAMPLES
        );
        assert!(segmenter.flush_stop().is_none());

        segmenter.reset();
        for _ in 0..PREROLL_BLOCKS {
            segmenter.push_block(&silence);
        }
        assert!(segmenter.flush_stop().is_none());
        assert_eq!(segmenter.processed_samples(), PREROLL_BLOCKS as u64 * 320);
    }

    #[test]
    fn endpoint_rejects_short_transient_spikes_in_steady_noise() {
        let mut segmenter = EnergyEndpointSegmenter::new();
        let silence = constant_block(0.0);
        let spike = constant_block(0.2);

        for _ in 0..20 {
            for _ in 0..(SPEECH_START_BLOCKS - 1) {
                assert!(segmenter.push_block(&spike).is_none());
            }
            assert!(segmenter.push_block(&silence).is_none());
        }

        assert!(!segmenter.is_active());
        assert!(segmenter.flush_stop().is_none());
    }

    #[test]
    fn endpoint_configuration_rejects_zero_or_incoherent_windows() {
        let invalid = EndpointConfig {
            speech_rms_threshold: f32::NAN,
            ..EndpointConfig::default()
        };
        assert_eq!(
            EnergyEndpointSegmenter::with_config(invalid).unwrap_err(),
            DspConfigError::InvalidEndpointConfig("speech_rms_threshold")
        );

        let invalid = EndpointConfig {
            max_segment_blocks: PREROLL_BLOCKS - 1,
            ..EndpointConfig::default()
        };
        assert_eq!(
            EnergyEndpointSegmenter::with_config(invalid).unwrap_err(),
            DspConfigError::InvalidEndpointConfig("max_segment_blocks")
        );

        let invalid = EndpointConfig {
            minimum_speech_blocks: SPEECH_START_BLOCKS - 1,
            ..EndpointConfig::default()
        };
        assert_eq!(
            EnergyEndpointSegmenter::with_config(invalid).unwrap_err(),
            DspConfigError::InvalidEndpointConfig("minimum_speech_blocks")
        );
    }
}
