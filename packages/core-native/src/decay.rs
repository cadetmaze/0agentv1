use napi_derive::napi;

use crate::types::{DecayUpdate, EdgeData};

/// Batch-apply time-based decay to edges, moving weights toward 0.5.
///
/// For each edge that is not locked and whose age exceeds `grace_ms`:
///   distance = |weight - 0.5|
///   hours    = (now_ms - last_traversed_or_created) / 3_600_000
///   delta    = min(decay_rate * distance * hours, max_delta)
///   new_weight moves toward 0.5 by `delta`, clamped so it never crosses 0.5.
///
/// Returns a JSON array of DecayUpdate objects (only edges whose weight changed).
#[napi]
pub fn batch_decay(edges_json: String, now_ms: f64, grace_ms: f64, max_delta: f64) -> String {
    let edges: Vec<EdgeData> = match serde_json::from_str(&edges_json) {
        Ok(e) => e,
        Err(_) => return "[]".to_string(),
    };

    let mut updates: Vec<DecayUpdate> = Vec::new();

    for edge in &edges {
        // Skip locked edges
        if edge.locked {
            continue;
        }

        // Determine the reference timestamp (last_traversed or created_at)
        let reference = edge.last_traversed.unwrap_or(edge.created_at);

        // Age in milliseconds
        let age_ms = now_ms - reference;

        // Skip edges within the grace period
        if age_ms <= grace_ms {
            continue;
        }

        let distance = (edge.weight - 0.5_f64).abs();

        // Nothing to decay if already at 0.5
        if distance < 1e-12 {
            continue;
        }

        let hours = age_ms / 3_600_000.0;
        let delta = (edge.decay_rate * distance * hours).min(max_delta);

        // Move toward 0.5
        let new_weight = if edge.weight > 0.5 {
            (edge.weight - delta).max(0.5)
        } else {
            (edge.weight + delta).min(0.5)
        };

        // Only emit an update if the weight actually changed
        if (new_weight - edge.weight).abs() > 1e-15 {
            updates.push(DecayUpdate {
                edge_id: edge.id.clone(),
                new_weight,
            });
        }
    }

    serde_json::to_string(&updates).unwrap_or_else(|_| "[]".to_string())
}
