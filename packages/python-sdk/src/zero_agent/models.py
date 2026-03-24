"""Pydantic models for the 0agent Python SDK."""

from pydantic import BaseModel
from typing import Any, Optional


class Session(BaseModel):
    id: str
    task: str
    status: str
    created_at: int
    started_at: Optional[int] = None
    completed_at: Optional[int] = None
    result: Optional[Any] = None
    error: Optional[str] = None


class GraphNode(BaseModel):
    id: str
    label: str
    type: str
    graph_id: str
    visit_count: int = 0
    metadata: dict = {}


class GraphEdge(BaseModel):
    id: str
    from_node: str
    to_node: str
    type: str
    weight: float = 0.5
    locked: bool = False


class Entity(BaseModel):
    id: str
    label: str
    type: str
    subgraph_node_count: Optional[int] = None
    subgraph_edge_count: Optional[int] = None


class Trace(BaseModel):
    id: str
    session_id: str
    input: str
    outcome_signal: Optional[float] = None
    outcome_type: Optional[str] = None
    created_at: int
    metadata: dict = {}


class SkillInfo(BaseModel):
    name: str
    description: str
    category: str
    trigger: str


class SkillResult(BaseModel):
    output: str
    format: str
    trace_id: Optional[str] = None
    duration_ms: Optional[int] = None
