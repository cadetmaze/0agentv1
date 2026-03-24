"""ZeroAgent — Python client for the 0agent daemon API."""

from __future__ import annotations

import time
from typing import Any, Optional

import httpx

from .models import (
    Entity,
    GraphEdge,
    GraphNode,
    Session,
    SkillInfo,
    SkillResult,
    Trace,
)


class ZeroAgent:
    """Synchronous Python SDK for 0agent.

    Connects to the daemon's REST API to create sessions, query the
    knowledge graph, invoke skills, and more.
    """

    def __init__(
        self,
        host: str = "localhost",
        port: int = 4200,
        timeout: float = 30.0,
    ) -> None:
        self.base_url = f"http://{host}:{port}"
        self._client = httpx.Client(base_url=self.base_url, timeout=timeout)

    # ------------------------------------------------------------------
    # Session lifecycle
    # ------------------------------------------------------------------

    def run(
        self,
        task: str,
        *,
        entity: Optional[str] = None,
        poll_interval: float = 1.0,
        max_wait: float = 300.0,
    ) -> Session:
        """Create a session, wait for completion, and return the result."""
        body: dict[str, Any] = {"task": task}
        if entity is not None:
            body["entity"] = entity

        resp = self._client.post("/api/sessions", json=body)
        resp.raise_for_status()
        session = Session(**resp.json())

        return self._wait_for_completion(session.id, poll_interval, max_wait)

    def create_session(
        self,
        task: str,
        *,
        entity: Optional[str] = None,
    ) -> Session:
        """Create a session without waiting for completion."""
        body: dict[str, Any] = {"task": task}
        if entity is not None:
            body["entity"] = entity

        resp = self._client.post("/api/sessions", json=body)
        resp.raise_for_status()
        return Session(**resp.json())

    def get_session(self, session_id: str) -> Session:
        """Fetch a session by ID."""
        resp = self._client.get(f"/api/sessions/{session_id}")
        resp.raise_for_status()
        return Session(**resp.json())

    def list_sessions(
        self,
        *,
        status: Optional[str] = None,
        limit: int = 50,
    ) -> list[Session]:
        """List sessions, optionally filtered by status."""
        params: dict[str, Any] = {"limit": limit}
        if status is not None:
            params["status"] = status

        resp = self._client.get("/api/sessions", params=params)
        resp.raise_for_status()
        return [Session(**s) for s in resp.json()]

    # ------------------------------------------------------------------
    # Entity / Graph
    # ------------------------------------------------------------------

    def get_entity(self, entity_id: str) -> Entity:
        """Retrieve an entity and its subgraph summary."""
        resp = self._client.get(f"/api/entities/{entity_id}")
        resp.raise_for_status()
        return Entity(**resp.json())

    def list_entities(self) -> list[Entity]:
        """List all known entities."""
        resp = self._client.get("/api/entities")
        resp.raise_for_status()
        return [Entity(**e) for e in resp.json()]

    def query_graph(
        self,
        graph_id: str,
        *,
        node_type: Optional[str] = None,
        limit: int = 100,
    ) -> dict[str, Any]:
        """Return nodes and edges for a graph, optionally filtered."""
        params: dict[str, Any] = {"limit": limit}
        if node_type is not None:
            params["node_type"] = node_type

        resp = self._client.get(f"/api/graphs/{graph_id}", params=params)
        resp.raise_for_status()
        data = resp.json()
        return {
            "nodes": [GraphNode(**n) for n in data.get("nodes", [])],
            "edges": [GraphEdge(**e) for e in data.get("edges", [])],
        }

    def search_nodes(
        self,
        query: str,
        *,
        graph_id: Optional[str] = None,
        limit: int = 20,
    ) -> list[GraphNode]:
        """Full-text search across graph nodes."""
        params: dict[str, Any] = {"q": query, "limit": limit}
        if graph_id is not None:
            params["graph_id"] = graph_id

        resp = self._client.get("/api/graph/search", params=params)
        resp.raise_for_status()
        return [GraphNode(**n) for n in resp.json()]

    # ------------------------------------------------------------------
    # Traces
    # ------------------------------------------------------------------

    def list_traces(
        self,
        session_id: str,
        *,
        limit: int = 50,
    ) -> list[Trace]:
        """List traces for a given session."""
        resp = self._client.get(
            f"/api/sessions/{session_id}/traces",
            params={"limit": limit},
        )
        resp.raise_for_status()
        return [Trace(**t) for t in resp.json()]

    # ------------------------------------------------------------------
    # Skills
    # ------------------------------------------------------------------

    def list_skills(self) -> list[SkillInfo]:
        """List available skills."""
        resp = self._client.get("/api/skills")
        resp.raise_for_status()
        return [SkillInfo(**s) for s in resp.json()]

    def invoke_skill(
        self,
        skill_name: str,
        *,
        input_text: str,
        session_id: Optional[str] = None,
    ) -> SkillResult:
        """Invoke a skill by name."""
        body: dict[str, Any] = {
            "skill": skill_name,
            "input": input_text,
        }
        if session_id is not None:
            body["session_id"] = session_id

        resp = self._client.post("/api/skills/invoke", json=body)
        resp.raise_for_status()
        return SkillResult(**resp.json())

    # ------------------------------------------------------------------
    # Workflow suggestions
    # ------------------------------------------------------------------

    def workflow_suggest(
        self,
        description: str,
        *,
        entity: Optional[str] = None,
    ) -> dict[str, Any]:
        """Get workflow suggestions for a given task description."""
        body: dict[str, Any] = {"description": description}
        if entity is not None:
            body["entity"] = entity

        resp = self._client.post("/api/workflow/suggest", json=body)
        resp.raise_for_status()
        return resp.json()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _wait_for_completion(
        self,
        session_id: str,
        poll_interval: float,
        max_wait: float,
    ) -> Session:
        """Poll until the session reaches a terminal status."""
        deadline = time.monotonic() + max_wait
        while time.monotonic() < deadline:
            session = self.get_session(session_id)
            if session.status in ("completed", "failed", "cancelled"):
                return session
            time.sleep(poll_interval)

        # Final fetch in case it completed just as we timed out
        return self.get_session(session_id)

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._client.close()

    def __enter__(self) -> ZeroAgent:
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()
