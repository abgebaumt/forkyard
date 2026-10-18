//! Vectors of the search index: at most 512 components, normalised, stored as int8 with one
//! scale per vector (spec 9.2: "256–512 Dimensionen, als f16/int8"). Models that return more
//! components are cut and normalised again – exact for Matryoshka models, an approximation for
//! others.

pub const MAX_DIMS: usize = 512;

/// Cut to `MAX_DIMS` and scale to length 1; `None` for an empty, zero or non-finite vector.
pub fn prepare(mut values: Vec<f32>) -> Option<Vec<f32>> {
    values.truncate(MAX_DIMS);
    if values.is_empty() || values.iter().any(|value| !value.is_finite()) {
        return None;
    }
    let norm = values.iter().map(|value| value * value).sum::<f32>().sqrt();
    if norm == 0.0 || !norm.is_finite() {
        return None;
    }
    Some(values.into_iter().map(|value| value / norm).collect())
}

/// int8 with the largest absolute component at ±127; returns (scale, components).
pub fn quantize(values: &[f32]) -> (f32, Vec<i8>) {
    let largest = values.iter().fold(0.0f32, |max, value| max.max(value.abs()));
    if largest == 0.0 {
        return (0.0, vec![0; values.len()]);
    }
    let scale = largest / 127.0;
    (scale, values.iter().map(|value| (value / scale).round().clamp(-127.0, 127.0) as i8).collect())
}

/// Cosine of a normalised question with a stored (normalised, quantised) vector.
pub fn score(query: &[f32], scale: f32, quantized: &[i8]) -> f32 {
    query.iter().zip(quantized).map(|(q, v)| q * f32::from(*v)).sum::<f32>() * scale
}

pub fn to_blob(quantized: &[i8]) -> Vec<u8> {
    quantized.iter().map(|value| *value as u8).collect()
}

pub fn from_blob(blob: &[u8]) -> Vec<i8> {
    blob.iter().map(|value| *value as i8).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vectors_are_cut_to_512_and_normalised() {
        assert_eq!(prepare(vec![3.0, 4.0]), Some(vec![0.6, 0.8]));
        let long = prepare(vec![1.0; 768]).unwrap();
        assert_eq!(long.len(), 512, "spec: at most 512 dimensions");
        let expected = 1.0 / (512.0f32).sqrt();
        assert!(long.iter().all(|v| (v - expected).abs() < 1e-6));
        assert_eq!(prepare(vec![2.0, 0.0, 0.0, 0.0]), Some(vec![1.0, 0.0, 0.0, 0.0]), "small vectors stay as they are");
        assert_eq!(prepare(Vec::new()), None);
        assert_eq!(prepare(vec![0.0, 0.0]), None, "a zero vector has no direction");
        assert_eq!(prepare(vec![f32::NAN, 1.0]), None);
        assert_eq!(prepare(vec![f32::INFINITY, 1.0]), None);
    }

    #[test]
    fn int8_keeps_one_scale_per_vector() {
        let (scale, quantized) = quantize(&[0.6, 0.8]);
        assert_eq!(quantized, vec![95, 127], "0.6 / (0.8 / 127) = 95.25");
        assert!((scale - 0.8 / 127.0).abs() < 1e-7);
        assert_eq!(quantize(&[-1.0, 0.0]).1, vec![-127, 0]);
        assert_eq!(quantize(&[0.0, 0.0]), (0.0, vec![0, 0]));
        assert_eq!(from_blob(&to_blob(&[-127, -1, 0, 1, 127])), vec![-127, -1, 0, 1, 127]);
    }

    #[test]
    fn scores_keep_the_cosine_order() {
        let query = [1.0, 0.0, 0.0];
        let score_of = |values: &[f32]| {
            let (scale, quantized) = quantize(values);
            score(&query, scale, &quantized)
        };
        let same = score_of(&[1.0, 0.0, 0.0]);
        let near = score_of(&[0.8, 0.6, 0.0]);
        let apart = score_of(&[0.0, 0.0, 1.0]);
        let opposite = score_of(&[-1.0, 0.0, 0.0]);
        assert!((same - 1.0).abs() < 0.01 && (near - 0.8).abs() < 0.01 && apart.abs() < 0.01 && (opposite + 1.0).abs() < 0.01, "{same} {near} {apart} {opposite}");
        let (scale, quantized) = quantize(&[0.6, 0.8]);
        assert!((score(&[0.6, 0.8], scale, &quantized) - 1.0).abs() < 0.01, "int8 keeps the cosine within 1 %");
    }
}
