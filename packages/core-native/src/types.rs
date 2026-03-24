use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgeData {
    pub id: String,
    pub from_node: String,
    pub to_node: String,
    pub weight: f64,
    pub locked: bool,
    pub decay_rate: f64,
    pub last_traversed: Option<f64>,
    pub created_at: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathResult {
    pub node_ids: Vec<String>,
    pub edge_ids: Vec<String>,
    pub weight_product: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecayUpdate {
    pub edge_id: String,
    pub new_weight: f64,
}
