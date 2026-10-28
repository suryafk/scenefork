"""Muse Voice proxy on the session WebSocket, against a stub transcriber (no network, no credits)."""

import asyncio
import json
from dataclasses import replace

from fastapi.testclient import TestClient

from app.adapters import build_adapters
from app.devcache import DevCache
from app.main import create_app
from app.spend import VOICE_PER_SECOND, SpendLedger
from app.voice import BYTES_PER_SECOND, MAX_SECONDS, keywords_for
from tests.test_ws import ORIGIN, recv_until


class StubStream:
    def __init__(self, owner):
        self.owner = owner
        self.audio = bytearray()
        self.queue: asyncio.Queue = asyncio.Queue()

    async def send_audio(self, pcm):
        self.audio += pcm
        # Like the real model: a running hypothesis as audio arrives.
        await self.queue.put({"type": "transcript", "transcript": "moon" if len(self.audio) < 3200 else "moon gravity", "final": False})

    async def end(self):
        self.owner.ended = True
        await self.queue.put({"type": "transcript", "transcript": "Moon gravity.", "final": True})
        await self.queue.put(None)

    async def events(self):
        while (ev := await self.queue.get()) is not None:
            yield ev

    async def close(self):
        self.owner.closed = True


class StubTranscriber:
    def __init__(self, delay=0.0):
        self.delay, self.keywords, self.stream, self.ended, self.closed = delay, None, None, False, False

    async def open(self, keywords):
        await asyncio.sleep(self.delay)  # the upstream handshake takes a moment
        self.keywords = keywords
        self.stream = StubStream(self)
        return self.stream


def app_with(settings, transcriber):
    adapters = replace(build_adapters(settings, SpendLedger(settings.spend_dir, 1.0), DevCache(settings.cache_dir, False)), transcriber=transcriber)
    return TestClient(create_app(settings, adapters))


def test_push_to_talk_streams_partials_then_the_final_transcript(settings):
    stub = StubTranscriber(delay=0.05)
    with app_with(settings, stub).websocket_connect("/ws", headers=ORIGIN) as ws:
        assert ws.receive_json()["voice"] is True
        ws.send_json({"type": "voice_start", "req_id": "v1", "keywords": ["small_potted_cactus", "slingshot", "moon"]})
        for _ in range(3):  # sent before the upstream is even connected: buffered, not lost
            ws.send_bytes(b"\x00\x01" * 800)
        ws.send_json({"type": "voice_end", "req_id": "v1"})
        partial, _ = recv_until(ws, "voice_partial")
        assert partial["text"].startswith("moon")
        final, _ = recv_until(ws, "voice_final")
        assert final == {"type": "voice_final", "req_id": "v1", "text": "Moon gravity.", "seconds": 0.15}
    assert len(stub.stream.audio) == 4800 and stub.ended and stub.closed
    assert stub.keywords == ["small", "potted", "cactus", "slingshot", "moon"]
    ledger = [json.loads(line) for line in (settings.spend_dir / "ledger.jsonl").read_text().splitlines()]
    assert ledger[-1]["kind"] == "muse-voice-transcribe-1.0" and abs(ledger[-1]["usd"] - 0.15 * VOICE_PER_SECOND) < 1e-6  # the ledger keeps 6 decimals


def test_holding_past_the_cap_ends_the_turn(settings):
    stub = StubTranscriber()
    with app_with(settings, stub).websocket_connect("/ws", headers=ORIGIN) as ws:
        ws.receive_json()
        ws.send_json({"type": "voice_start", "req_id": "v2", "keywords": []})
        chunk = b"\x00" * BYTES_PER_SECOND
        for _ in range(MAX_SECONDS + 3):
            ws.send_bytes(chunk)
        final, _ = recv_until(ws, "voice_final", limit=200)
        assert final["seconds"] <= MAX_SECONDS
    assert stub.ended


def test_voice_is_unavailable_on_fake_models(settings):
    with app_with(settings, None).websocket_connect("/ws", headers=ORIGIN) as ws:
        assert ws.receive_json()["voice"] is False
        ws.send_json({"type": "voice_start", "req_id": "v3", "keywords": []})
        failed, _ = recv_until(ws, "voice_failed")
        assert failed["reason"] == "unavailable"


def test_a_fork_frame_still_follows_its_header(settings):
    from app import vision
    from tests.conftest import street_scene

    with app_with(settings, StubTranscriber()).websocket_connect("/ws", headers=ORIGIN) as ws:
        ws.receive_json()
        ws.send_json({"type": "fork", "req_id": "f1", "clip_hash": "x", "t_fork": 0})
        ws.send_bytes(vision.encode_jpeg(street_scene()))
        forked, _ = recv_until(ws, "forked")
        assert forked["width"] == 1280


def test_keywords_are_words_from_labels_without_duplicates():
    assert keywords_for(["red_delivery_truck", "traffic cone", "Truck 2"], ["bouncy"]) == ["red", "delivery", "truck", "traffic", "cone", "bouncy"]
