"""SceneFork backend: one WebSocket per browser session for fork/free, signed asset URLs for images.

Protocol (JSON text frames; the frame upload is one binary frame right after its `fork` header):

client → server
  {"type": "fork", "req_id", "clip_hash", "t_fork"}  + binary JPEG (≤ 1.5 MB)
  {"type": "free", "req_id", "fork_id", "x", "y"}     click in frame pixels
  {"type": "cancel", "req_id"}                         drop a free whose result isn't back yet
  {"type": "voice_start", "req_id", "keywords"}      then binary PCM frames (16 kHz s16le mono)
  {"type": "voice_end", "req_id"}                      push-to-talk released
  {"type": "codegen", "req_id", "text", "scene", "bindings", "attempt", "previous", "variant"?}
  {"type": "suggest", "req_id", "entities"}           rule ideas for the freed objects (chips)
                                                       one MutatorAgent call; the browser verifies and
                                                       asks again (attempt 1-2) with the error
server → client
  {"type": "hello", "live", "voice"}                         on connect; voice: Muse Voice available
  {"type": "forked", "req_id", "fork_id", "width", "height"}
  {"type": "freed", "req_id", "fork_id", "entity", "timing_ms"}  entity: shared/entity.schema.json
  {"type": "free_failed", "req_id", "fork_id", "reason", "message"}  reason: no_object | already_freed | spend_cap | error
  {"type": "grounded", "fork_id", "entity_id", "grounding"}  grounding: shared/grounding.schema.json
  {"type": "plate", "fork_id", "entity_id", "version", "url", "method"}
  {"type": "codegen_result", "req_id", "attempt", "plugin", "problems", "ms", "cached"}
                                                             plugin: shared/plugin.schema.json
  {"type": "codegen_failed", "req_id", "reason", "message"}  reason: spend_cap | error | bad_request
  {"type": "suggestions", "req_id", "suggestions", "cached"}  suggestions: shared/suggestions.schema.json
  {"type": "voice_partial", "req_id", "text"}       Muse Voice's running transcript
  {"type": "voice_final", "req_id", "text", "seconds"}
  {"type": "voice_failed", "req_id", "reason", "message"}  reason: unavailable | spend_cap | error
  {"type": "spend", "total_usd", "cap_usd"}
  {"type": "error", "code", "req_id", "fork_id"?}           code: unknown_fork | bad_request | bad_frame | frame_too_large
"""

import asyncio
import json
from dataclasses import dataclass, field
import logging
import time
from contextlib import asynccontextmanager

import cv2
from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from . import contracts, vision
from .adapters import Adapters, build_adapters
from .config import Settings, load_settings
from .devcache import DevCache
from .mutator import MAX_ATTEMPT, MAX_COMMAND_CHARS, CodegenRequest
from .suggest import scene_entities
from .spend import VOICE_PER_SECOND
from .voice import BYTES_PER_SECOND, MAX_SECONDS, VOICE_RESERVE, ASRStream, keywords_for
from .session import AssetSigner, Fork, SessionStore
from .spend import SpendCapExceeded, SpendLedger

log = logging.getLogger("scenefork")
MAX_FRAME_BYTES = int(1.5 * 1024 * 1024)
MODEL_VOICE = "muse-voice-transcribe-1.0"
MAX_FRAME_SIDE = 1280
WS_UNAUTHORIZED = 4401
WS_FORBIDDEN_ORIGIN = 4403
#: A new outline this much inside already-freed pixels is the same object clicked again.
DUPLICATE_OVERLAP = 0.5


class Backend:
    """Everything one process shares: settings, forks, money, models."""

    def __init__(self, settings: Settings, adapters: Adapters | None = None) -> None:
        self.settings = settings
        self.ledger = SpendLedger(settings.spend_dir, settings.spend_cap_usd)
        self.cache = DevCache(settings.cache_dir, settings.dev_cache)
        self.adapters = adapters or build_adapters(settings, self.ledger, self.cache)
        self.forks = SessionStore(settings.fork_ttl_s)
        self.signer = AssetSigner(settings.asset_secret)


def create_app(settings: Settings | None = None, adapters: Adapters | None = None) -> FastAPI:
    backend = Backend(settings or load_settings(), adapters)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        log.info("adapters=%s spend=$%.4f cap=$%.2f", "live" if backend.adapters.live else "fake", backend.ledger.total_usd, backend.ledger.cap_usd)
        yield

    app = FastAPI(title="SceneFork", lifespan=lifespan)
    app.state.backend = backend
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(backend.settings.allowed_origins),
        allow_methods=["GET"],
        allow_headers=["*"],
    )

    @app.get("/health")
    def health() -> dict:
        return {"ok": True, "live": backend.adapters.live, "forks": len(backend.forks), "spend_usd": round(backend.ledger.total_usd, 4)}

    @app.get("/asset/{fork_id}/{asset_id}")
    def asset(fork_id: str, asset_id: str, sig: str = Query("")) -> Response:
        if not backend.signer.verify(fork_id, asset_id, sig):
            return Response(status_code=403)
        fork = backend.forks.get(fork_id)
        if fork is None or asset_id not in fork.assets:
            return Response(status_code=404)
        data, ctype = fork.assets[asset_id]
        return Response(data, media_type=ctype, headers={"Cache-Control": "private, max-age=1800"})

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket, k: str = Query("")) -> None:
        origin = ws.headers.get("origin")
        refuse = None
        if origin and origin not in backend.settings.allowed_origins:
            refuse = WS_FORBIDDEN_ORIGIN
        elif backend.settings.demo_token and k != backend.settings.demo_token:
            refuse = WS_UNAUTHORIZED
        # Accept, then close: closing during the handshake reaches the browser as a bare 1006,
        # so it couldn't tell "demo key required" from a network drop and would retry forever.
        await ws.accept()
        if refuse is not None:
            await ws.close(code=refuse)
            return
        await Session(backend, ws).run()

    return app


@dataclass
class VoiceTurn:
    """One push-to-talk utterance. Audio that arrives while the upstream is still connecting waits."""

    req_id: str
    stream: ASRStream | None = None
    waiting: list[bytes] = field(default_factory=list)
    sent_bytes: int = 0
    ended: bool = False


class Session:
    """One browser connection. Frees run as concurrent tasks; sends are serialized."""

    def __init__(self, backend: Backend, ws: WebSocket) -> None:
        self.b = backend
        self.ws = ws
        self.send_lock = asyncio.Lock()
        self.tasks: set[asyncio.Task] = set()
        #: Frees the user cancelled (clicked their ring again) before segmentation finished.
        self.cancelled: set[str] = set()
        #: A `fork` header waiting for its JPEG frame.
        self.pending_fork: dict | None = None
        self.voice: VoiceTurn | None = None

    async def send(self, msg: dict) -> None:
        async with self.send_lock:
            await self.ws.send_text(json.dumps(msg))

    async def send_spend(self) -> None:
        await self.send({"type": "spend", "total_usd": round(self.b.ledger.total_usd, 4), "cap_usd": self.b.ledger.cap_usd})

    def spawn(self, coro) -> None:
        task = asyncio.create_task(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def run(self) -> None:
        await self.send({"type": "hello", "live": self.b.adapters.live, "voice": self.b.adapters.transcriber is not None})
        await self.send_spend()
        try:
            while True:
                frame = await self.ws.receive()
                if frame["type"] == "websocket.disconnect":
                    break
                if frame.get("bytes") is not None:
                    # Binary frames are the JPEG right after a `fork` header, or voice audio.
                    if self.pending_fork is not None:
                        header, self.pending_fork = self.pending_fork, None
                        await self.on_fork(header, frame["bytes"])
                    else:
                        await self.on_audio(frame["bytes"])
                    continue
                try:
                    msg = json.loads(frame.get("text") or "")
                except json.JSONDecodeError:
                    await self.send({"type": "error", "code": "bad_request", "req_id": None})
                    continue
                kind = msg.get("type")
                if kind == "fork":
                    self.pending_fork = msg
                elif kind == "voice_start":
                    await self.on_voice_start(msg)
                elif kind == "voice_end":
                    await self.on_voice_end(msg)
                elif kind == "free":
                    self.spawn(self.on_free(msg))
                elif kind == "codegen":
                    self.spawn(self.on_codegen(msg))
                elif kind == "suggest":
                    self.spawn(self.on_suggest(msg))
                elif kind == "cancel":
                    self.cancelled.add(str(msg.get("req_id")))
                else:
                    await self.send({"type": "error", "code": "bad_request", "req_id": msg.get("req_id")})
        except WebSocketDisconnect:
            pass
        finally:
            for t in list(self.tasks):
                t.cancel()
            if self.voice and self.voice.stream:
                await self.voice.stream.close()

    # ------------------------------------------------------------ voice (Muse Voice Transcribe)

    async def on_voice_start(self, msg: dict) -> None:
        req_id = str(msg.get("req_id"))

        def failed(reason: str, message: str) -> dict:
            return {"type": "voice_failed", "req_id": req_id, "reason": reason, "message": message}

        transcriber = self.b.adapters.transcriber
        if transcriber is None:
            await self.send(failed("unavailable", "Muse Voice needs live models (SCENEFORK_ADAPTERS=live)"))
            return
        if self.voice and self.voice.stream:
            await self.voice.stream.close()
        try:
            self.b.ledger.check(VOICE_RESERVE)
        except SpendCapExceeded as e:
            await self.send(failed("spend_cap", str(e)))
            return
        turn = VoiceTurn(req_id)
        self.voice = turn
        keywords = keywords_for([str(k) for k in (msg.get("keywords") or [])][:80], [])
        self.spawn(self.run_voice(turn, transcriber, keywords))

    async def on_audio(self, pcm: bytes) -> None:
        turn = self.voice
        if turn is None or turn.ended:
            return
        if turn.sent_bytes + sum(map(len, turn.waiting)) + len(pcm) > MAX_SECONDS * BYTES_PER_SECOND:
            await self.end_voice(turn)  # held too long: transcribe what we have
            return
        if turn.stream is None:
            turn.waiting.append(pcm)
            return
        turn.sent_bytes += len(pcm)
        await turn.stream.send_audio(pcm)

    async def on_voice_end(self, msg: dict) -> None:
        if self.voice and self.voice.req_id == str(msg.get("req_id")):
            await self.end_voice(self.voice)

    async def end_voice(self, turn: VoiceTurn) -> None:
        if turn.ended:
            return
        turn.ended = True
        if turn.stream is not None:
            await turn.stream.end()

    async def run_voice(self, turn: VoiceTurn, transcriber, keywords: list[str]) -> None:
        text, final = "", None
        try:
            turn.stream = await transcriber.open(keywords)
            for pcm in turn.waiting:
                turn.sent_bytes += len(pcm)
                await turn.stream.send_audio(pcm)
            turn.waiting.clear()
            if turn.ended:
                await turn.stream.end()
            async for ev in turn.stream.events():
                kind = ev.get("type")
                if kind == "transcript":
                    text = ev.get("transcript", "")
                    await self.send({"type": "voice_partial", "req_id": turn.req_id, "text": text})
                    if ev.get("final"):
                        final = text
                elif kind == "speechComplete":
                    final = ev.get("transcript", text)
                elif kind == "error":
                    raise RuntimeError(ev.get("message", "voice error"))
        except Exception as e:  # network or model errors: this utterance fails, the session lives
            log.warning("voice failed: %s", e)
            await self.send({"type": "voice_failed", "req_id": turn.req_id, "reason": "error", "message": type(e).__name__})
            return
        finally:
            seconds = turn.sent_bytes / BYTES_PER_SECOND
            if seconds > 0:
                self.b.ledger.charge(MODEL_VOICE, seconds * VOICE_PER_SECOND, seconds=round(seconds, 2))
            if turn.stream is not None:
                await turn.stream.close()
            if self.voice is turn:
                self.voice = None
        await self.send({"type": "voice_final", "req_id": turn.req_id, "text": final if final is not None else text, "seconds": round(seconds, 2)})
        await self.send_spend()

    async def on_fork(self, msg: dict, data: bytes) -> None:
        req_id = msg.get("req_id")
        if len(data) > MAX_FRAME_BYTES:
            await self.send({"type": "error", "code": "frame_too_large", "req_id": req_id})
            return
        try:
            frame = vision.decode_image(data)
        except ValueError:
            await self.send({"type": "error", "code": "bad_frame", "req_id": req_id})
            return
        h, w = frame.shape[:2]
        if max(h, w) > MAX_FRAME_SIDE:
            s = MAX_FRAME_SIDE / max(h, w)
            frame = cv2.resize(frame, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA)
            data = vision.encode_jpeg(frame, 90)
        fork = self.b.forks.create(frame, data)
        w, h = fork.size
        await self.send({"type": "forked", "req_id": req_id, "fork_id": fork.id, "width": w, "height": h})

    async def on_free(self, msg: dict) -> None:
        req_id = msg.get("req_id")
        fork_id = msg.get("fork_id", "")
        fork = self.b.forks.get(fork_id)
        if fork is None:
            await self.send({"type": "error", "code": "unknown_fork", "req_id": req_id, "fork_id": fork_id})
            return
        w, h = fork.size
        x = int(min(max(msg.get("x", 0), 0), w - 1))
        y = int(min(max(msg.get("y", 0), 0), h - 1))

        def failed(reason: str, message: str = "") -> dict:
            return {"type": "free_failed", "req_id": req_id, "fork_id": fork_id, "reason": reason, "message": message}

        taken = fork.taken
        if taken is not None and taken[y, x]:
            # A click on an object that is already free (its body missed the pointer): no model call.
            await self.send(failed("already_freed"))
            return
        t0 = time.perf_counter()
        try:
            plate_jpeg = await asyncio.to_thread(vision.encode_jpeg, fork.plate, 90)
            mask = await self.b.adapters.segmenter.segment(fork.plate, plate_jpeg, x, y)
        except SpendCapExceeded as e:
            await self.send(failed("spend_cap", str(e)))
            await self.send_spend()
            return
        except Exception as e:  # network or model errors: the click fails, the session lives
            log.exception("segment failed")
            await self.send(failed("error", type(e).__name__))
            return
        t_seg = time.perf_counter()
        if req_id in self.cancelled:
            # Segmentation is already paid for; skipping the rest saves the inpaint and grounding.
            self.cancelled.discard(req_id)
            await self.send(failed("cancelled"))
            return
        taken = fork.taken
        if mask is not None and taken is not None:
            # Mostly an object that's already free (a click on its edge): not a new one.
            if (mask & taken).sum() > DUPLICATE_OVERLAP * max(int(mask.sum()), 1):
                await self.send(failed("already_freed"))
                await self.send_spend()
                return
            mask = mask & ~taken  # a neighbor's outline may include part of a freed object
        # OpenCV work runs off the event loop so sockets and asset downloads stay responsive.
        obj = await asyncio.to_thread(vision.compile_object, fork.plate, mask) if mask is not None else None
        if obj is None:
            await self.send(failed("no_object"))
            await self.send_spend()
            return
        # Checked again with no await before the update: two clicks on one object may both be in flight.
        taken = fork.taken
        if taken is not None and (obj.mask & taken).sum() > DUPLICATE_OVERLAP * obj.area_px:
            await self.send(failed("already_freed"))
            await self.send_spend()
            return

        entity_id = f"obj_{fork.next_object}"
        fork.next_object += 1
        fork.unpainted[entity_id] = obj.mask
        sprite_id = f"sprite_{entity_id}.webp"
        fork.assets[sprite_id] = (obj.sprite_webp, "image/webp")
        d = contracts.defaults_for(None)
        entity = {
            "id": entity_id,
            "label": "object",
            "polygon_px": obj.polygon_px,
            "sprite_url": self.b.signer.url(fork.id, sprite_id),
            "sprite_bbox": obj.bbox,
            "physics": {"mass_kg": d["mass_kg"], "restitution": d["restitution"], "friction": d["friction"]},
            "acoustic_material": d["acoustic_material"],
        }
        await self.send(
            {
                "type": "freed",
                "req_id": req_id,
                "fork_id": fork.id,
                "entity": entity,
                "timing_ms": {"segment": round((t_seg - t0) * 1000), "compile": round((time.perf_counter() - t_seg) * 1000)},
            }
        )
        await self.send_spend()
        # Release before grounding (design step 5): grounding and inpainting follow in parallel.
        frame_for_grounding = fork.plate.copy()
        self.spawn(self.ground(fork, entity_id, frame_for_grounding, obj))
        self.spawn(self.inpaint(fork, entity_id, obj))

    async def on_codegen(self, msg: dict) -> None:
        req_id = msg.get("req_id")

        def failed(reason: str, message: str) -> dict:
            return {"type": "codegen_failed", "req_id": req_id, "reason": reason, "message": message}

        text = msg.get("text")
        attempt = msg.get("attempt", 0)
        scene = msg.get("scene")
        previous = msg.get("previous")
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_COMMAND_CHARS or not isinstance(scene, dict):
            await self.send(failed("bad_request", "codegen needs text (at most 300 characters) and a scene"))
            return
        # The repair cap is enforced here too, so a buggy client can't loop on paid calls.
        if not isinstance(attempt, int) or not 0 <= attempt <= MAX_ATTEMPT or (attempt > 0 and not isinstance(previous, dict)):
            await self.send(failed("bad_request", f"attempt must be 0-{MAX_ATTEMPT}, and repairs need the previous plugin"))
            return
        variant = msg.get("variant", 0)
        variant = variant if isinstance(variant, int) and 0 <= variant <= 99 else 0
        req = CodegenRequest(text.strip(), scene, msg.get("bindings") or {}, attempt, previous if attempt else None, variant)
        t0 = time.perf_counter()
        try:
            result = await self.b.adapters.mutator.generate(req)
        except SpendCapExceeded as e:
            await self.send(failed("spend_cap", str(e)))
            await self.send_spend()
            return
        except Exception as e:
            log.exception("codegen failed")
            await self.send(failed("error", f"the model call failed ({type(e).__name__})"))
            return
        await self.send(
            {
                "type": "codegen_result",
                "req_id": req_id,
                "attempt": attempt,
                "plugin": result.plugin,
                "problems": result.problems,
                "ms": round((time.perf_counter() - t0) * 1000),
                "cached": result.cached,
            }
        )
        await self.send_spend()

    async def on_suggest(self, msg: dict) -> None:
        entities = scene_entities(msg.get("entities"))
        if not entities:
            await self.send({"type": "suggestions", "req_id": msg.get("req_id"), "suggestions": [], "cached": True})
            return
        try:
            result = await self.b.adapters.suggester.suggest(entities)
        except Exception as e:  # suggestions are a nicety: fail quietly, the app still works
            log.warning("suggest failed: %s", e)
            result = None
        await self.send({"type": "suggestions", "req_id": msg.get("req_id"), "suggestions": result.suggestions if result else [], "cached": bool(result and result.cached)})
        if result and not result.cached:
            await self.send_spend()

    async def ground(self, fork: Fork, entity_id: str, frame, obj: vision.CompiledObject) -> None:
        try:
            g = contracts.pin_background(await self.b.adapters.grounder.ground(frame, obj))
        except Exception as e:
            log.warning("grounding failed for %s: %s", entity_id, e)
            return  # the body keeps its label defaults
        await self.send({"type": "grounded", "fork_id": fork.id, "entity_id": entity_id, "grounding": g})
        await self.send_spend()

    async def inpaint(self, fork: Fork, entity_id: str, obj: vision.CompiledObject) -> None:
        async with fork.inpaint_lock:
            try:
                result = await self.b.adapters.inpainter.remove(fork.plate, obj.inpaint_mask, None)
            finally:
                # Painted out (or failed): either way it's no longer a duplicate hazard to block.
                fork.unpainted.pop(entity_id, None)
            fork.plate = result.plate
            fork.plate_version += 1
            plate_id = f"plate_{fork.plate_version}.webp"
            fork.assets[plate_id] = (await asyncio.to_thread(vision.encode_webp, fork.plate, 90), "image/webp")
            # Older plates are never shown again.
            for old in [a for a in fork.assets if a.startswith("plate_") and a != plate_id]:
                del fork.assets[old]
            await self.send(
                {
                    "type": "plate",
                    "fork_id": fork.id,
                    "entity_id": entity_id,
                    "version": fork.plate_version,
                    "url": self.b.signer.url(fork.id, plate_id),
                    "method": result.method,
                }
            )
        await self.send_spend()

