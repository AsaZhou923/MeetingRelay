use std::collections::BTreeMap;

use super::{
    raw_audio::{RawAudioManifest, read_mixed_feature_window_16khz},
    storage::{DurableFinal, sha256_hex},
};

pub const SPEAKER_ALGORITHM_VERSION: &str = "meetingrelay.speaker.acoustic-cluster.v2";
pub const MAX_SPEAKER_ASSIGNMENTS: usize = 10_000;
const MAX_FEATURE_SAMPLES_PER_SEGMENT: usize = 16_000;
const MAX_SPEAKER_SEGMENT_SAMPLES: u64 = 16_000 * 60 * 5;
const MAX_SPEAKER_TOTAL_MEETING_SAMPLES: u64 = 16_000 * 60 * 60 * 12;
const MAX_SPEAKER_MANIFEST_SOURCES: usize = 8;
const MAX_SPEAKER_MANIFEST_GAPS: usize = 10_000;
const MIN_VOICED_RMS: f64 = 0.0005;
const CLUSTER_DISTANCE_THRESHOLD: f64 = 0.28;
const MAX_SPEAKER_CLUSTERS: usize = 3;

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerIdentity {
    pub speaker_id: String,
    pub display_name: String,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerSegmentAssignment {
    pub segment_id: String,
    pub sequence: u64,
    pub source_revision: u32,
    pub speaker_id: String,
    pub confidence: f32,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerVersionDraft {
    pub parent_version: Option<u32>,
    pub base_version: Option<u32>,
    pub algorithm: String,
    pub identities: Vec<SpeakerIdentity>,
    pub assignments: Vec<SpeakerSegmentAssignment>,
    pub operation: String,
    pub idempotency_key: Option<String>,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerVersionSnapshot {
    pub meeting_id: String,
    pub version: u32,
    pub parent_version: Option<u32>,
    pub algorithm: String,
    pub digest: String,
    pub created_at: String,
    pub operation: String,
    pub identities: Vec<SpeakerIdentity>,
    pub assignments: Vec<SpeakerSegmentAssignment>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerRenameRequest {
    pub meeting_id: String,
    pub speaker_id: String,
    pub display_name: String,
    pub base_version: u32,
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerMergeRequest {
    pub meeting_id: String,
    pub from_speaker_id: String,
    pub into_speaker_id: String,
    pub display_name: Option<String>,
    pub base_version: u32,
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerUndoRequest {
    pub meeting_id: String,
    pub base_version: u32,
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerDiarizationResult {
    pub meeting_id: String,
    pub version: Option<u32>,
    pub status: String,
    pub reason: Option<String>,
}

#[derive(Clone, Copy, Debug)]
struct WindowFeature {
    zcr: f64,
    centroid: f64,
    bandwidth: f64,
    pitch_80: f64,
    pitch_160: f64,
    pitch_320: f64,
    envelope: f64,
    voiced: bool,
}

pub fn draft_from_raw_audio(
    manifest: &RawAudioManifest,
    finals: &[DurableFinal],
) -> Result<Option<SpeakerVersionDraft>, String> {
    if finals.is_empty() {
        return Ok(None);
    }
    validate_diarization_bounds(manifest, finals)?;
    let mut features = Vec::with_capacity(finals.len());
    for final_segment in finals {
        let samples = read_mixed_feature_window_16khz(
            manifest,
            final_segment.meeting_sample_start,
            final_segment.meeting_sample_end,
            MAX_FEATURE_SAMPLES_PER_SEGMENT,
        )
        .map_err(|_| "SPEAKER_RAW_AUDIO_UNAVAILABLE".to_owned())?;
        features.push(feature_for_samples(&samples));
    }
    Ok(Some(draft_from_features(
        finals, &features, None, "diarize", None,
    )))
}

pub fn rename_draft(
    current: &SpeakerVersionSnapshot,
    request: &SpeakerRenameRequest,
) -> Result<SpeakerVersionDraft, String> {
    validate_display_name(&request.display_name)?;
    ensure_version(current, request.base_version)?;
    let mut identities = current.identities.clone();
    let mut found = false;
    for identity in &mut identities {
        if identity.speaker_id == request.speaker_id {
            identity.display_name = request.display_name.clone();
            found = true;
        }
    }
    if !found {
        return Err("SPEAKER_IDENTITY_NOT_FOUND".to_owned());
    }
    Ok(SpeakerVersionDraft {
        parent_version: Some(current.version),
        base_version: Some(request.base_version),
        algorithm: "meetingrelay.speaker.manual.rename.v1".to_owned(),
        identities,
        assignments: current.assignments.clone(),
        operation: "rename".to_owned(),
        idempotency_key: Some(request.idempotency_key.clone()),
    })
}

pub fn merge_draft(
    current: &SpeakerVersionSnapshot,
    request: &SpeakerMergeRequest,
) -> Result<SpeakerVersionDraft, String> {
    ensure_version(current, request.base_version)?;
    if request.from_speaker_id == request.into_speaker_id {
        return Err("SPEAKER_MERGE_INVALID".to_owned());
    }
    if let Some(name) = request.display_name.as_deref() {
        validate_display_name(name)?;
    }
    let mut identities = Vec::new();
    let mut from_found = false;
    let mut into_found = false;
    for mut identity in current.identities.clone() {
        if identity.speaker_id == request.from_speaker_id {
            from_found = true;
            continue;
        }
        if identity.speaker_id == request.into_speaker_id {
            into_found = true;
            if let Some(name) = request.display_name.as_deref() {
                identity.display_name = name.to_owned();
            }
        }
        identities.push(identity);
    }
    if !from_found || !into_found {
        return Err("SPEAKER_IDENTITY_NOT_FOUND".to_owned());
    }
    let assignments = current
        .assignments
        .iter()
        .cloned()
        .map(|mut assignment| {
            if assignment.speaker_id == request.from_speaker_id {
                assignment.speaker_id = request.into_speaker_id.clone();
                assignment.confidence = assignment.confidence.min(0.99);
            }
            assignment
        })
        .collect();
    Ok(SpeakerVersionDraft {
        parent_version: Some(current.version),
        base_version: Some(request.base_version),
        algorithm: "meetingrelay.speaker.manual.merge.v1".to_owned(),
        identities,
        assignments,
        operation: "merge".to_owned(),
        idempotency_key: Some(request.idempotency_key.clone()),
    })
}

pub fn undo_draft(
    current: &SpeakerVersionSnapshot,
    parent: &SpeakerVersionSnapshot,
    request: &SpeakerUndoRequest,
) -> Result<SpeakerVersionDraft, String> {
    ensure_version(current, request.base_version)?;
    Ok(SpeakerVersionDraft {
        parent_version: Some(current.version),
        base_version: Some(request.base_version),
        algorithm: "meetingrelay.speaker.manual.undo.v1".to_owned(),
        identities: parent.identities.clone(),
        assignments: parent.assignments.clone(),
        operation: "undo".to_owned(),
        idempotency_key: Some(request.idempotency_key.clone()),
    })
}

pub fn speaker_digest(
    identities: &[SpeakerIdentity],
    assignments: &[SpeakerSegmentAssignment],
) -> String {
    let mut canonical = String::new();
    for identity in identities {
        canonical.push_str(&identity.speaker_id);
        canonical.push('\t');
        canonical.push_str(&identity.display_name);
        canonical.push('\n');
    }
    canonical.push_str("---\n");
    for assignment in assignments {
        canonical.push_str(&assignment.segment_id);
        canonical.push('\t');
        canonical.push_str(&assignment.sequence.to_string());
        canonical.push('\t');
        canonical.push_str(&assignment.source_revision.to_string());
        canonical.push('\t');
        canonical.push_str(&assignment.speaker_id);
        canonical.push('\n');
        canonical.push_str(&stable_confidence(assignment.confidence));
        canonical.push('\n');
    }
    sha256_hex(canonical.as_bytes())
}

fn draft_from_features(
    finals: &[DurableFinal],
    features: &[WindowFeature],
    parent_version: Option<u32>,
    operation: &str,
    idempotency_key: Option<String>,
) -> SpeakerVersionDraft {
    let clustering = cluster_features(features);
    let cluster_count = clustering.cluster_count;
    let identities = (0..cluster_count)
        .map(|index| SpeakerIdentity {
            speaker_id: format!("spk-{}", index + 1),
            display_name: format!("Speaker {}", index + 1),
        })
        .collect::<Vec<_>>();
    let assignments = finals
        .iter()
        .zip(features)
        .zip(clustering.assignments.iter())
        .enumerate()
        .map(
            |(index, ((final_segment, _feature), cluster_index))| SpeakerSegmentAssignment {
                segment_id: final_segment.segment_id.clone(),
                sequence: final_segment.sequence,
                source_revision: final_segment.revision,
                speaker_id: identities[*cluster_index].speaker_id.clone(),
                confidence: clustering.confidences[index],
            },
        )
        .collect();
    SpeakerVersionDraft {
        parent_version,
        base_version: parent_version,
        algorithm: SPEAKER_ALGORITHM_VERSION.to_owned(),
        identities,
        assignments,
        operation: operation.to_owned(),
        idempotency_key,
    }
}

fn validate_diarization_bounds(
    manifest: &RawAudioManifest,
    finals: &[DurableFinal],
) -> Result<(), String> {
    if finals.len() > MAX_SPEAKER_ASSIGNMENTS {
        return Err("SPEAKER_ASSIGNMENT_LIMIT_EXCEEDED".to_owned());
    }
    if manifest.sources.len() > MAX_SPEAKER_MANIFEST_SOURCES {
        return Err("SPEAKER_RAW_AUDIO_SOURCE_LIMIT_EXCEEDED".to_owned());
    }
    let gap_count = manifest
        .sources
        .iter()
        .try_fold(0_usize, |total, source| {
            total
                .checked_add(source.gaps.len())
                .ok_or("SPEAKER_RAW_AUDIO_GAP_LIMIT_EXCEEDED")
        })
        .map_err(str::to_owned)?;
    if gap_count > MAX_SPEAKER_MANIFEST_GAPS {
        return Err("SPEAKER_RAW_AUDIO_GAP_LIMIT_EXCEEDED".to_owned());
    }
    let mut meeting_start = u64::MAX;
    let mut meeting_end = 0_u64;
    for final_segment in finals {
        if final_segment.meeting_sample_end <= final_segment.meeting_sample_start {
            return Err("SPEAKER_SEGMENT_SAMPLE_RANGE_INVALID".to_owned());
        }
        let span = final_segment
            .meeting_sample_end
            .saturating_sub(final_segment.meeting_sample_start);
        if span > MAX_SPEAKER_SEGMENT_SAMPLES {
            return Err("SPEAKER_SEGMENT_SAMPLE_LIMIT_EXCEEDED".to_owned());
        }
        meeting_start = meeting_start.min(final_segment.meeting_sample_start);
        meeting_end = meeting_end.max(final_segment.meeting_sample_end);
    }
    if meeting_end.saturating_sub(meeting_start) > MAX_SPEAKER_TOTAL_MEETING_SAMPLES {
        return Err("SPEAKER_MEETING_SAMPLE_LIMIT_EXCEEDED".to_owned());
    }
    Ok(())
}

fn feature_for_samples(samples: &[f32]) -> WindowFeature {
    if samples.is_empty() {
        return silent_feature();
    }
    let stride = (samples.len() / MAX_FEATURE_SAMPLES_PER_SEGMENT).max(1);
    let sampled = samples
        .iter()
        .step_by(stride)
        .take(MAX_FEATURE_SAMPLES_PER_SEGMENT)
        .map(|sample| f64::from(sample.clamp(-1.0, 1.0)))
        .collect::<Vec<_>>();
    if sampled.len() < 32 {
        return silent_feature();
    }
    let mut sum_squares = 0.0_f64;
    let mut crossings = 0_u64;
    for window in sampled.windows(2) {
        sum_squares += window[0] * window[0];
        if window[0].signum() != window[1].signum() {
            crossings += 1;
        }
    }
    sum_squares += sampled.last().copied().unwrap_or(0.0).powi(2);
    let rms = (sum_squares / sampled.len() as f64).sqrt();
    if rms < MIN_VOICED_RMS {
        return silent_feature();
    }
    let normalized = sampled
        .iter()
        .map(|sample| (sample / rms).clamp(-8.0, 8.0))
        .collect::<Vec<_>>();
    let zcr = crossings as f64 / sampled.len() as f64;
    let (centroid, bandwidth) = spectral_shape(&normalized);
    WindowFeature {
        zcr,
        centroid,
        bandwidth,
        pitch_80: autocorrelation(&normalized, 80 / stride.max(1)),
        pitch_160: autocorrelation(&normalized, 160 / stride.max(1)),
        pitch_320: autocorrelation(&normalized, 320 / stride.max(1)),
        envelope: envelope_variation(&normalized),
        voiced: true,
    }
}

fn silent_feature() -> WindowFeature {
    WindowFeature {
        zcr: 0.0,
        centroid: 0.0,
        bandwidth: 0.0,
        pitch_80: 0.0,
        pitch_160: 0.0,
        pitch_320: 0.0,
        envelope: 0.0,
        voiced: false,
    }
}

fn spectral_shape(samples: &[f64]) -> (f64, f64) {
    let mut total = 0.0_f64;
    let mut weighted = 0.0_f64;
    let mut weighted_square = 0.0_f64;
    let bins = [2_usize, 4, 8, 16, 32, 64];
    for bin in bins {
        let mut real = 0.0_f64;
        let mut imag = 0.0_f64;
        let angle_step = std::f64::consts::TAU * bin as f64 / samples.len() as f64;
        for (index, sample) in samples.iter().enumerate() {
            let angle = angle_step * index as f64;
            real += sample * angle.cos();
            imag -= sample * angle.sin();
        }
        let magnitude = (real * real + imag * imag).sqrt();
        let frequency = bin as f64 / 64.0;
        total += magnitude;
        weighted += magnitude * frequency;
        weighted_square += magnitude * frequency * frequency;
    }
    if total <= f64::EPSILON {
        return (0.0, 0.0);
    }
    let centroid = weighted / total;
    let variance = (weighted_square / total - centroid * centroid).max(0.0);
    (centroid, variance.sqrt())
}

fn autocorrelation(samples: &[f64], lag: usize) -> f64 {
    if lag == 0 || lag >= samples.len() / 2 {
        return 0.0;
    }
    let mut numerator = 0.0_f64;
    let mut left = 0.0_f64;
    let mut right = 0.0_f64;
    for index in lag..samples.len() {
        let a = samples[index - lag];
        let b = samples[index];
        numerator += a * b;
        left += a * a;
        right += b * b;
    }
    if left <= f64::EPSILON || right <= f64::EPSILON {
        return 0.0;
    }
    (numerator / (left.sqrt() * right.sqrt())).clamp(-1.0, 1.0)
}

fn envelope_variation(samples: &[f64]) -> f64 {
    let chunk = (samples.len() / 16).max(1);
    let mut values = Vec::new();
    for part in samples.chunks(chunk) {
        let mean = part.iter().map(|sample| sample.abs()).sum::<f64>() / part.len() as f64;
        values.push(mean);
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    if mean <= f64::EPSILON {
        return 0.0;
    }
    let variance = values
        .iter()
        .map(|value| {
            let delta = value - mean;
            delta * delta
        })
        .sum::<f64>()
        / values.len() as f64;
    (variance.sqrt() / mean).min(2.0) / 2.0
}

#[derive(Clone, Debug)]
struct FeatureClustering {
    cluster_count: usize,
    assignments: Vec<usize>,
    confidences: Vec<f32>,
}

fn cluster_features(features: &[WindowFeature]) -> FeatureClustering {
    let raw_vectors = feature_vectors(features);
    let vectors = standardized_vectors(features);
    if vectors.is_empty() {
        return FeatureClustering {
            cluster_count: 1,
            assignments: Vec::new(),
            confidences: Vec::new(),
        };
    }
    let max_distance = max_pairwise_distance(&raw_vectors);
    let requested = if features.iter().filter(|feature| feature.voiced).count() < 2
        || max_distance < CLUSTER_DISTANCE_THRESHOLD
    {
        1
    } else if max_distance > 0.72 && vectors.len() >= 6 {
        MAX_SPEAKER_CLUSTERS.min(vectors.len())
    } else {
        2.min(vectors.len())
    };
    let (mut assignments, mut centroids) = deterministic_kmeans(&vectors, requested);
    let mut order = (0..centroids.len()).collect::<Vec<_>>();
    order.sort_by(|left, right| {
        centroid_sort_key(&centroids[*left]).total_cmp(&centroid_sort_key(&centroids[*right]))
    });
    let mut remap = vec![0_usize; centroids.len()];
    for (new, old) in order.iter().enumerate() {
        remap[*old] = new;
    }
    for assignment in &mut assignments {
        *assignment = remap[*assignment];
    }
    centroids = order.into_iter().map(|old| centroids[old]).collect();
    let confidences = vectors
        .iter()
        .zip(assignments.iter())
        .map(|(vector, cluster)| confidence(vector, features, &centroids, *cluster))
        .collect();
    FeatureClustering {
        cluster_count: centroids.len(),
        assignments,
        confidences,
    }
}

fn feature_vectors(features: &[WindowFeature]) -> Vec<[f64; 7]> {
    features
        .iter()
        .map(|feature| {
            [
                feature.zcr,
                feature.centroid,
                feature.bandwidth,
                feature.pitch_80,
                feature.pitch_160,
                feature.pitch_320,
                feature.envelope,
            ]
        })
        .collect()
}

fn standardized_vectors(features: &[WindowFeature]) -> Vec<[f64; 7]> {
    let raw = feature_vectors(features);
    let mut means = [0.0_f64; 7];
    for vector in &raw {
        for (index, value) in vector.iter().enumerate() {
            means[index] += value;
        }
    }
    for mean in &mut means {
        *mean /= raw.len().max(1) as f64;
    }
    let mut deviations = [0.0_f64; 7];
    for vector in &raw {
        for (index, value) in vector.iter().enumerate() {
            deviations[index] += (value - means[index]).powi(2);
        }
    }
    for deviation in &mut deviations {
        *deviation = (*deviation / raw.len().max(1) as f64).sqrt().max(0.05);
    }
    raw.into_iter()
        .map(|vector| {
            let mut output = [0.0_f64; 7];
            for index in 0..7 {
                output[index] =
                    ((vector[index] - means[index]) / deviations[index]).clamp(-4.0, 4.0);
            }
            output
        })
        .collect()
}

fn max_pairwise_distance(vectors: &[[f64; 7]]) -> f64 {
    let mut max = 0.0_f64;
    for left in 0..vectors.len() {
        for right in (left + 1)..vectors.len() {
            max = max.max(distance(&vectors[left], &vectors[right]));
        }
    }
    max
}

fn deterministic_kmeans(vectors: &[[f64; 7]], k: usize) -> (Vec<usize>, Vec<[f64; 7]>) {
    let mut centroids = Vec::new();
    centroids.push(vectors[0]);
    while centroids.len() < k {
        let next = vectors
            .iter()
            .enumerate()
            .max_by(|(left_index, left), (right_index, right)| {
                let left_distance = nearest_distance(left, &centroids);
                let right_distance = nearest_distance(right, &centroids);
                left_distance
                    .total_cmp(&right_distance)
                    .then_with(|| right_index.cmp(left_index))
            })
            .map(|(_, vector)| *vector)
            .unwrap_or(vectors[0]);
        centroids.push(next);
    }
    let mut assignments = vec![0_usize; vectors.len()];
    for _ in 0..8 {
        let mut changed = false;
        for (index, vector) in vectors.iter().enumerate() {
            let cluster = nearest_centroid(vector, &centroids);
            changed |= assignments[index] != cluster;
            assignments[index] = cluster;
        }
        recompute_centroids(vectors, &assignments, &mut centroids);
        if !changed {
            break;
        }
    }
    (assignments, centroids)
}

fn nearest_distance(vector: &[f64; 7], centroids: &[[f64; 7]]) -> f64 {
    centroids
        .iter()
        .map(|centroid| distance(vector, centroid))
        .fold(f64::INFINITY, f64::min)
}

fn nearest_centroid(vector: &[f64; 7], centroids: &[[f64; 7]]) -> usize {
    centroids
        .iter()
        .enumerate()
        .min_by(|(left_index, left), (right_index, right)| {
            distance(vector, left)
                .total_cmp(&distance(vector, right))
                .then_with(|| left_index.cmp(right_index))
        })
        .map(|(index, _)| index)
        .unwrap_or(0)
}

fn recompute_centroids(vectors: &[[f64; 7]], assignments: &[usize], centroids: &mut [[f64; 7]]) {
    let mut sums = vec![[0.0_f64; 7]; centroids.len()];
    let mut counts = vec![0_usize; centroids.len()];
    for (vector, assignment) in vectors.iter().zip(assignments) {
        counts[*assignment] += 1;
        for (index, value) in vector.iter().enumerate() {
            sums[*assignment][index] += value;
        }
    }
    for (index, centroid) in centroids.iter_mut().enumerate() {
        if counts[index] == 0 {
            continue;
        }
        for dimension in 0..7 {
            centroid[dimension] = sums[index][dimension] / counts[index] as f64;
        }
    }
}

fn distance(left: &[f64; 7], right: &[f64; 7]) -> f64 {
    left.iter()
        .zip(right)
        .map(|(left, right)| (left - right).powi(2))
        .sum::<f64>()
        .sqrt()
        / (left.len() as f64).sqrt()
}

fn centroid_sort_key(centroid: &[f64; 7]) -> f64 {
    centroid[1] * 10.0 + centroid[0] + centroid[3] * 0.25
}

fn confidence(
    vector: &[f64; 7],
    features: &[WindowFeature],
    centroids: &[[f64; 7]],
    cluster_index: usize,
) -> f32 {
    if features.iter().all(|feature| !feature.voiced) {
        return 0.2;
    }
    if centroids.len() == 1 {
        return 0.72;
    }
    let own = distance(vector, &centroids[cluster_index]);
    let other = centroids
        .iter()
        .enumerate()
        .filter(|(index, _)| *index != cluster_index)
        .map(|(_, centroid)| distance(vector, centroid))
        .fold(f64::INFINITY, f64::min);
    let margin = (other - own).clamp(0.0, 1.0);
    (0.62 + margin * 0.3) as f32
}

fn stable_confidence(value: f32) -> String {
    format!("{:.3}", value.clamp(0.0, 1.0))
}

fn validate_display_name(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 80 || value.chars().any(char::is_control) {
        return Err("SPEAKER_DISPLAY_NAME_INVALID".to_owned());
    }
    Ok(())
}

fn ensure_version(current: &SpeakerVersionSnapshot, base_version: u32) -> Result<(), String> {
    if current.version != base_version {
        return Err("SPEAKER_BASE_VERSION_CONFLICT".to_owned());
    }
    Ok(())
}

pub fn assignment_display_names(
    version: Option<&SpeakerVersionSnapshot>,
) -> BTreeMap<(String, u64), String> {
    let Some(version) = version else {
        return BTreeMap::new();
    };
    let names = version
        .identities
        .iter()
        .map(|identity| (identity.speaker_id.clone(), identity.display_name.clone()))
        .collect::<BTreeMap<_, _>>();
    version
        .assignments
        .iter()
        .filter_map(|assignment| {
            names.get(&assignment.speaker_id).map(|name| {
                (
                    (assignment.segment_id.clone(), assignment.sequence),
                    name.clone(),
                )
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn final_segment(sequence: u64) -> DurableFinal {
        DurableFinal {
            meeting_id: "meeting".to_owned(),
            segment_id: format!("seg-{sequence}"),
            sequence,
            revision: 1,
            text: format!("segment {sequence}"),
            started_at_ms: "0".to_owned(),
            ended_at_ms: "1".to_owned(),
            content_sha256: String::new(),
            committed_at: "1".to_owned(),
            commit_id: format!("commit-{sequence}"),
            meeting_sample_start: sequence * 100,
            meeting_sample_end: sequence * 100 + 100,
            timeline_revision: 1,
            translation_status: "disabled".to_owned(),
            translation_target: None,
            translation_text: None,
            translation_error: None,
        }
    }

    fn empty_manifest() -> RawAudioManifest {
        RawAudioManifest {
            meeting_id: "meeting".to_owned(),
            raw_dir: std::path::PathBuf::from("raw"),
            derived_dir: std::path::PathBuf::from("derived"),
            sources: Vec::new(),
        }
    }

    fn sine(frequency: f64, amplitude: f64) -> Vec<f32> {
        (0..16_000)
            .map(|index| {
                (std::f64::consts::TAU * frequency * index as f64 / 16_000.0).sin() * amplitude
            })
            .map(|sample| sample as f32)
            .collect()
    }

    fn square(frequency: f64, amplitude: f64) -> Vec<f32> {
        sine(frequency, 1.0)
            .into_iter()
            .map(|sample| {
                if sample >= 0.0 {
                    amplitude as f32
                } else {
                    -amplitude as f32
                }
            })
            .collect()
    }

    #[test]
    fn acoustic_clustering_normalizes_volume_for_same_voiceprint() {
        let finals = vec![
            final_segment(1),
            final_segment(2),
            final_segment(3),
            final_segment(4),
        ];
        let features = vec![
            feature_for_samples(&sine(220.0, 0.15)),
            feature_for_samples(&sine(220.0, 0.85)),
            feature_for_samples(&sine(220.0, 0.25)),
            feature_for_samples(&sine(220.0, 0.65)),
        ];
        let first = draft_from_features(&finals, &features, None, "diarize", None);
        let second = draft_from_features(&finals, &features, None, "diarize", None);
        assert_eq!(first.assignments, second.assignments);
        assert_eq!(first.identities.len(), 1);
    }

    #[test]
    fn acoustic_clustering_separates_distinct_timbre_and_pitch() {
        let finals = vec![
            final_segment(1),
            final_segment(2),
            final_segment(3),
            final_segment(4),
            final_segment(5),
            final_segment(6),
        ];
        let features = vec![
            feature_for_samples(&sine(180.0, 0.5)),
            feature_for_samples(&sine(180.0, 0.7)),
            feature_for_samples(&sine(180.0, 0.3)),
            feature_for_samples(&square(520.0, 0.5)),
            feature_for_samples(&square(520.0, 0.7)),
            feature_for_samples(&square(520.0, 0.3)),
        ];
        let draft = draft_from_features(&finals, &features, None, "diarize", None);
        assert!(draft.identities.len() >= 2);
        assert_ne!(
            draft.assignments[0].speaker_id,
            draft.assignments[3].speaker_id
        );
    }

    #[test]
    fn acoustic_clustering_is_safe_and_deterministic_for_silence() {
        let finals = vec![final_segment(1), final_segment(2)];
        let silence = vec![0.0_f32; 16_000];
        let features = vec![feature_for_samples(&silence), feature_for_samples(&silence)];
        let first = draft_from_features(&finals, &features, None, "diarize", None);
        let second = draft_from_features(&finals, &features, None, "diarize", None);
        assert_eq!(first.assignments, second.assignments);
        assert_eq!(first.identities.len(), 1);
        assert!(
            first
                .assignments
                .iter()
                .all(|assignment| assignment.confidence <= 0.72)
        );
    }

    #[test]
    fn speaker_digest_includes_stable_confidence() {
        let identities = vec![SpeakerIdentity {
            speaker_id: "spk-1".to_owned(),
            display_name: "Speaker 1".to_owned(),
        }];
        let mut assignments = vec![SpeakerSegmentAssignment {
            segment_id: "seg-1".to_owned(),
            sequence: 1,
            source_revision: 1,
            speaker_id: "spk-1".to_owned(),
            confidence: 0.7,
        }];
        let first = speaker_digest(&identities, &assignments);
        assignments[0].confidence = 0.8;
        assert_ne!(first, speaker_digest(&identities, &assignments));
    }

    #[test]
    fn diarization_rejects_frontend_assignment_and_span_limits_before_raw_read() {
        let manifest = empty_manifest();
        let too_many = (0..=MAX_SPEAKER_ASSIGNMENTS)
            .map(|index| final_segment(index as u64 + 1))
            .collect::<Vec<_>>();
        assert_eq!(
            draft_from_raw_audio(&manifest, &too_many).unwrap_err(),
            "SPEAKER_ASSIGNMENT_LIMIT_EXCEEDED"
        );

        let mut too_long = final_segment(1);
        too_long.meeting_sample_end =
            too_long.meeting_sample_start + MAX_SPEAKER_SEGMENT_SAMPLES + 1;
        assert_eq!(
            draft_from_raw_audio(&manifest, &[too_long]).unwrap_err(),
            "SPEAKER_SEGMENT_SAMPLE_LIMIT_EXCEEDED"
        );
    }

    #[test]
    fn rename_and_merge_require_current_base_version() {
        let snapshot = SpeakerVersionSnapshot {
            meeting_id: "meeting".to_owned(),
            version: 2,
            parent_version: Some(1),
            algorithm: SPEAKER_ALGORITHM_VERSION.to_owned(),
            digest: String::new(),
            created_at: "1".to_owned(),
            operation: "diarize".to_owned(),
            identities: vec![
                SpeakerIdentity {
                    speaker_id: "spk-1".to_owned(),
                    display_name: "Speaker 1".to_owned(),
                },
                SpeakerIdentity {
                    speaker_id: "spk-2".to_owned(),
                    display_name: "Speaker 2".to_owned(),
                },
            ],
            assignments: vec![SpeakerSegmentAssignment {
                segment_id: "seg-1".to_owned(),
                sequence: 1,
                source_revision: 1,
                speaker_id: "spk-1".to_owned(),
                confidence: 0.8,
            }],
        };
        let conflict = rename_draft(
            &snapshot,
            &SpeakerRenameRequest {
                meeting_id: "meeting".to_owned(),
                speaker_id: "spk-1".to_owned(),
                display_name: "Alice".to_owned(),
                base_version: 1,
                idempotency_key: "rename-1".to_owned(),
            },
        )
        .unwrap_err();
        assert_eq!(conflict, "SPEAKER_BASE_VERSION_CONFLICT");
        let renamed = rename_draft(
            &snapshot,
            &SpeakerRenameRequest {
                meeting_id: "meeting".to_owned(),
                speaker_id: "spk-1".to_owned(),
                display_name: "Alice".to_owned(),
                base_version: 2,
                idempotency_key: "rename-2".to_owned(),
            },
        )
        .unwrap();
        assert_eq!(renamed.identities[0].display_name, "Alice");
    }
}
