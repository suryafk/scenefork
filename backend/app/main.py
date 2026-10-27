"""SceneFork backend: one WebSocket per browser session for fork/free, signed asset URLs for images.

Protocol (JSON text frames; the frame upload is one binary frame right after its `fork` header):

client → server
  {"type": "fork", "req_id", "clip_hash", "t_fork"}  + binary JPEG (≤ 1.5 MB)
  {"type": "free", "req_id", "fork_id", "x", "y"}     click in frame pixels
  {"type": "cancel", "req_id"}                         drop a free whose result isn't back yet
server → client
  {"type": "hello", "live"}                                  on connect
  {"type": "forked", "req_id", "fork_id", "width", "height"}
  {"type": "freed", "req_id", "fork_id", "entity", "timing_ms"}  entity: shared/entity.schema.json
  {"type": "free_failed", "req_id", "fork_id", "reason", "message"}  reason: no_object | spend_cap | error
  {"type": "grounded", "fork_id", "entity_id", "grounding"}  grounding: shared/grounding.schema.json
  {"type": "plate", "fork_id", "entity_id", "version", "url", "method"}
  {"type": "spend", "total_usd", "cap_usd"}
  {"type": "error", "code", "req_id", "fork_id"?}           code: unknown_fork | bad_request | bad_frame | frame_too_large
"""

import asyncio
import json
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
from .session import AssetSigner, Fork, SessionStore
from .spend import SpendCapExceeded, SpendLedger

log = logging.getLogger("scenefork")
MAX_FRAME_BYTES = int(1.5 * 1024 * 1024)
MAX_FRAME_SIDE = 1280
WS_UNAUTHORIZED = 4401
WS_FORBIDDEN_ORIGIN = 4403


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
        if origin and origin not in backend.settings.allowed_origins:
            await ws.close(code=WS_FORBIDDEN_ORIGIN)
            return
        if backend.settings.demo_token and k != backend.settings.demo_token:
            await ws.close(code=WS_UNAUTHORIZED)
            return
        await ws.accept()
        await Session(backend, ws).run()

    return app


class Session:
    """One browser connection. Frees run as concurrent tasks; sends are serialized."""

    def __init__(self, backend: Backend, ws: WebSocket) -> None:
        self.b = backend
        self.ws = ws
        self.send_lock = asyncio.Lock()
        self.tasks: set[asyncio.Task] = set()
        #: Frees the user cancelled (clicked their ring again) before segmentation finished.
        self.cancelled: set[str] = set()

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
        await self.send({"type": "hello", "live": self.b.adapters.live})
        await self.send_spend()
        try:
            while True:
                msg = await self.ws.receive_json()
                kind = msg.get("type")
                if kind == "fork":
                    frame_bytes = await self.ws.receive_bytes()
                    await self.on_fork(msg, frame_bytes)
                elif kind == "free":
                    self.spawn(self.on_free(msg))
                elif kind == "cancel":
                    self.cancelled.add(str(msg.get("req_id")))
                else:
                    await self.send({"type": "error", "code": "bad_request", "req_id": msg.get("req_id")})
        except WebSocketDisconnect:
            pass
        finally:
            for t in list(self.tasks):
                t.cancel()

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
        # OpenCV work runs off the event loop so sockets and asset downloads stay responsive.
        obj = await asyncio.to_thread(vision.compile_object, fork.plate, mask) if mask is not None else None
        if obj is None:
            await self.send(failed("no_object"))
            await self.send_spend()
            return

        entity_id = f"obj_{fork.next_object}"
        fork.next_object += 1
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
            result = await self.b.adapters.inpainter.remove(fork.plate, obj.inpaint_mask, None)
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

