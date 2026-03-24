use napi_derive::napi;
use std::collections::{HashMap, HashSet, VecDeque};

use crate::types::{EdgeData, PathResult};

/// BFS from start_node returning the top-k paths by descending weight product.
///
/// `edges_json` is a JSON array of EdgeData objects.
/// Returns a JSON array of PathResult objects.
#[napi]
pub fn bfs_top_k(start_node: String, edges_json: String, max_depth: u32, top_k: u32) -> String {
    let edges: Vec<EdgeData> = match serde_json::from_str(&edges_json) {
        Ok(e) => e,
        Err(_) => return "[]".to_string(),
    };

    // Build adjacency map: from_node -> Vec<(edge_index)>
    let mut adjacency: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, edge) in edges.iter().enumerate() {
        adjacency
            .entry(edge.from_node.clone())
            .or_default()
            .push(i);
    }

    // BFS state: (current_node, path_node_ids, path_edge_ids, weight_product, visited_nodes)
    let mut queue: VecDeque<(String, Vec<String>, Vec<String>, f64, HashSet<String>)> =
        VecDeque::new();

    let mut initial_visited = HashSet::new();
    initial_visited.insert(start_node.clone());

    queue.push_back((
        start_node.clone(),
        vec![start_node.clone()],
        vec![],
        1.0,
        initial_visited,
    ));

    let mut all_paths: Vec<PathResult> = Vec::new();

    while let Some((current, node_ids, edge_ids, weight_product, visited)) = queue.pop_front() {
        let depth = edge_ids.len() as u32;

        // Record every path that has at least one edge
        if !edge_ids.is_empty() {
            all_paths.push(PathResult {
                node_ids: node_ids.clone(),
                edge_ids: edge_ids.clone(),
                weight_product,
            });
        }

        // Stop expanding if we've reached max depth
        if depth >= max_depth {
            continue;
        }

        if let Some(neighbors) = adjacency.get(&current) {
            for &edge_idx in neighbors {
                let edge = &edges[edge_idx];
                let next_node = &edge.to_node;

                // Avoid cycles
                if visited.contains(next_node) {
                    continue;
                }

                let mut new_node_ids = node_ids.clone();
                new_node_ids.push(next_node.clone());

                let mut new_edge_ids = edge_ids.clone();
                new_edge_ids.push(edge.id.clone());

                let new_weight = weight_product * edge.weight;

                let mut new_visited = visited.clone();
                new_visited.insert(next_node.clone());

                queue.push_back((
                    next_node.clone(),
                    new_node_ids,
                    new_edge_ids,
                    new_weight,
                    new_visited,
                ));
            }
        }
    }

    // Sort by weight_product descending
    all_paths.sort_by(|a, b| {
        b.weight_product
            .partial_cmp(&a.weight_product)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // Take top-k
    all_paths.truncate(top_k as usize);

    serde_json::to_string(&all_paths).unwrap_or_else(|_| "[]".to_string())
}
