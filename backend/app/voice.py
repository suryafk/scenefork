"""Muse Voice Transcribe, realtime (eng review OV5, the Meta path for voice).

The browser streams mic audio over the session WebSocket; this proxies it to
wss://api.meta.ai/v1/asr/realtime, because that endpoint authenticates inside its first frame and
the API key must never reach the browser. Push-to-talk: the client delimits the turn by ending the
stream, and the final transcript follows. Partials stream back as they arrive, so presets can fire
before the user lets go.

    browser ──voice_start{keywords}──► Session ──handshake{auth, PCM_16KHZ, keywords}──► Muse Voice
            ──PCM binary frames──────►         ──PCM binary frames──────────────────►
            ──voice_end──────────────►         ──{"type":"endStream"}───────────────►
            ◄─voice_partial / voice_final ◄──── transcript events, final=true ◄─────
"""

import json
import ssl
import uuid
from collections.abc import AsyncIterator
from typing import Protocol

import certifi
import websockets

from .spend import VOICE_PER_SECOND

MODEL = "muse-voice-transcribe-1.0"
BYTES_PER_SECOND = 16_000 * 2  # PCM_16KHZ: signed 16-bit little-endian mono
#: Design: the push-to-talk window is capped at 15 s.
MAX_SECONDS = 15
MAX_KEYWORDS = 60
VOICE_RESERVE = MAX_SECONDS * VOICE_PER_SECOND


class ASRStream(Protocol):
    async def send_audio(self, pcm: bytes) -> None: ...
    async def end(self) -> None: ...
    def events(self) -> AsyncIterator[dict]: ...
    async def close(self) -> None: ...


class Transcriber(Protocol):
    async def open(self, keywords: list[str]) -> ASRStream: ...


class LiveASRStream:
    def __init__(self, ws) -> None:
        self.ws = ws

    async def send_audio(self, pcm: bytes) -> None:
        await self.ws.send(pcm)

    async def end(self) -> None:
        # Half-close: the server flushes the final transcript, then closes with 1000.
        await self.ws.send(json.dumps({"type": "endStream"}))

    async def events(self) -> AsyncIterator[dict]:
        try:
            async for raw in self.ws:
                if isinstance(raw, str):
                    yield json.loads(raw)
        except websockets.ConnectionClosed:
            return

    async def close(self) -> None:
        await self.ws.close()


class LiveTranscriber:
    def __init__(self, api_key: str, base_url: str) -> None:
        if not api_key:
            raise RuntimeError("MODEL_API_KEY is not set; live voice needs it (backend/.env)")
        self.api_key = api_key
        self.url = base_url.replace("https://", "wss://").replace("http://", "ws://").rstrip("/") + "/asr/realtime"

    async def open(self, keywords: list[str]) -> ASRStream:
        # certifi's CA bundle, like httpx: python.org builds of Python ship without system roots.
        tls = ssl.create_default_context(cafile=certifi.where()) if self.url.startswith("wss://") else None
        ws = await websockets.connect(f"{self.url}?sessionId=scenefork-{uuid.uuid4().hex[:12]}", open_timeout=10, max_size=2**20, ssl=tls)
        handshake = {
            "authorization": {"accessToken": f"Bearer {self.api_key}"},
            "audioEncoding": "PCM_16KHZ",
            "model": MODEL,
            "mode": "PUSH_TO_TALK",
            "partialMode": "CUMULATIVE",
            "emitAudioProgress": False,
            "languageBias": ["English"],
        }
        if keywords:
            handshake["keywords"] = keywords[:MAX_KEYWORDS]
        await ws.send(json.dumps(handshake))
        ack = json.loads(await ws.recv())
        if ack.get("type") == "error":
            await ws.close()
            raise RuntimeError(f"voice handshake refused: {ack.get('message', '')[:200]}")
        return LiveASRStream(ws)


def keywords_for(labels: list[str], extra: list[str]) -> list[str]:
    """Bias recognition toward what's on screen and the rule vocabulary ("slingshot", "bouncy")."""
    words: list[str] = []
    for text in [*labels, *extra]:
        for w in str(text).replace("_", " ").split():
            w = w.strip().lower()
            if len(w) >= 3 and w.isalpha() and w not in words:
                words.append(w)
    return words[:MAX_KEYWORDS]
