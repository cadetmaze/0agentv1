"""WebSocket event stream for real-time 0agent events."""

from __future__ import annotations

import asyncio
import json
from typing import Callable, Optional

import websockets


class EventStream:
    """Subscribe to real-time events from the 0agent daemon over WebSocket."""

    def __init__(self, host: str = "localhost", port: int = 4200) -> None:
        self.url = f"ws://{host}:{port}/ws"

    async def subscribe(
        self,
        topics: list[str],
        handler: Callable[[dict], None],
        duration: Optional[float] = None,
    ) -> None:
        """Connect, subscribe to topics, and dispatch events to handler.

        Args:
            topics: List of topic strings to subscribe to.
            handler: Callback invoked with each parsed event dict.
            duration: If set, automatically disconnect after this many seconds.
        """
        async with websockets.connect(self.url) as ws:
            await ws.send(
                json.dumps({"type": "subscribe", "topics": topics})
            )
            if duration is not None:
                try:
                    await asyncio.wait_for(
                        self._listen(ws, handler), timeout=duration
                    )
                except asyncio.TimeoutError:
                    pass
            else:
                await self._listen(ws, handler)

    async def _listen(
        self,
        ws: websockets.WebSocketClientProtocol,
        handler: Callable[[dict], None],
    ) -> None:
        async for msg in ws:
            event = json.loads(msg)
            handler(event)
