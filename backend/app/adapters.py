"""Model adapters behind one interface each, so a missing or failing model is a config switch.

Fake adapters are free OpenCV stand-ins (tests and offline dev). Live adapters call the Meta
Model API and go through the SpendLedger and DevCache on every call.
"""

import asyncio
import json
from dataclasses import dataclass
from typing import Protocol

import meta_sam_parser as sam
import numpy as np

from . import contracts, vision
from .devcache import DevCache, request_key
from .metaapi import MetaModelAPI, data_url
from .mutator import FakeMutator, LiveMutator, Mutator
from .spend import IMAGE_PER_EDIT, SAM_PER_IMAGE, SPARK_RESERVE, SpendLedger, spark_cost


@dataclass
class InpaintResult:
    plate: np.ndarray
    method: str  # "muse", "telea" or "fake"


class Segmenter(Protocol):
    async def segment(self, frame: np.ndarray, frame_jpeg: bytes, x: int, y: int, more: tuple[tuple[int, int], ...] = ()) -> np.ndarray | None:
        """Mask of the object at (x, y); `more` adds positive points on the same object."""
        ...


class Grounder(Protocol):
    async def ground(self, frame: np.ndarray, obj: vision.CompiledObject) -> dict: ...


class Inpainter(Protocol):
    async def remove(self, plate: np.ndarray, region: np.ndarray, label: str | None) -> InpaintResult: ...


@dataclass
class Adapters:
    segmenter: Segmenter
    grounder: Grounder
    inpainter: Inpainter
    live: bool
    mutator: Mutator


# ---------------------------------------------------------------- fakes (free)


class FakeSegmenter:
    async def segment(self, frame, frame_jpeg, x, y, more=()):
        return await asyncio.to_thread(vision.flood_mask, frame, x, y)


class FakeGrounder:
    def __init__(self, delay_s: float = 0.0) -> None:
        self.delay_s = delay_s

    async def ground(self, frame, obj):
        await asyncio.sleep(self.delay_s)
        d = contracts.defaults_for(None)
        height_m = obj.bbox["h"] / 100
        return {
            "label": "object",
            "body_type": "dynamic",
            "mass_kg": d["mass_kg"],
            "restitution": d["restitution"],
            "friction": d["friction"],
            "acoustic_material": d["acoustic_material"],
            "approx_height_m": max(height_m, 0.01),
        }


class FakeInpainter:
    async def remove(self, plate, region, label):
        return InpaintResult(await asyncio.to_thread(vision.telea_fill, plate, region), "fake")


# ---------------------------------------------------------------- live (costs credits)


class LiveSegmenter:
    """sam-3.1 with one positive point prompt at the click."""

    def __init__(self, api: MetaModelAPI, ledger: SpendLedger, cache: DevCache) -> None:
        self.api, self.ledger, self.cache = api, ledger, cache

    async def segment(self, frame, frame_jpeg, x, y, more=()):
        h, w = frame.shape[:2]
        points = [sam.PromptPoint(x, y), *(sam.PromptPoint(px, py) for px, py in more)]
        prompt = sam.build_object_prompt(size=(w, h), objects=[sam.PromptObject(id=1, prompts=[sam.FramePrompt(points=points)])])
        key = request_key("sam-3.1", prompt, frame_jpeg)
        events = self.cache.get_json(key)
        if events is None:
            self.ledger.check(SAM_PER_IMAGE)
            events = await self.api.sam_events(frame_jpeg, prompt)
            self.ledger.charge("sam-3.1", SAM_PER_IMAGE, w=w, h=h)
            self.cache.put_json(key, events)
        return await mask_from_events(events, w, h)


async def mask_from_events(events: list[dict], w: int, h: int) -> np.ndarray | None:
    """Rebuild the full-frame mask: SAM's raster covers the object's box, anchored at its top-left."""

    async def source():
        for e in events:
            yield e

    result = await sam.parse_responses_stream(source(), sam.image_segmentation_format()).final_result()
    out = np.zeros((h, w), dtype=bool)
    found = False
    for rec in result.records:
        if rec.kind != "mask":
            continue
        raster = np.frombuffer(sam.decode_mask_to_raster(rec.mask), np.uint8).reshape(rec.mask.height, rec.mask.width)
        b = rec.bounds
        bh, bw = min(raster.shape[0], h - b.top), min(raster.shape[1], w - b.left)
        out[b.top : b.top + bh, b.left : b.left + bw] |= raster[:bh, :bw] > 0
        found = True
    return out if found else None


GROUNDING_PROMPT = (
    "The object outlined in yellow will become a 2D rigid body in a physics game built from this frame. "
    "Name it briefly and estimate its real-world physics: body_type 'fixed' only for things that cannot move "
    "(buildings, walls, poles, ground); mass in kg; restitution 0-0.95; friction 0-1.5; the closest acoustic "
    "material; and its real height in meters."
)


class LiveGrounder:
    """muse-spark-1.3, Standard mode, reasoning_effort=minimal (Phase 0: about 2.3 s)."""

    def __init__(self, api: MetaModelAPI, ledger: SpendLedger, cache: DevCache, effort: str) -> None:
        self.api, self.ledger, self.cache, self.effort = api, ledger, cache, effort

    async def ground(self, frame, obj):
        view = await asyncio.to_thread(vision.outlined_view, frame, obj)
        key = request_key("muse-spark-1.3", self.effort, GROUNDING_PROMPT, view)
        doc = self.cache.get_json(key)
        if doc is None:
            self.ledger.check(SPARK_RESERVE)
            content = [{"type": "text", "text": GROUNDING_PROMPT}, {"type": "image_url", "image_url": {"url": data_url(view, "image/jpeg")}}]
            doc, usage = await self.api.spark_json("muse-spark-1.3", self.effort, content, contracts.model_schema("grounding"), "Grounding")
            self.ledger.charge("muse-spark-1.3", spark_cost(usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0)), purpose="grounding")
            self.cache.put_json(key, doc)
        doc = contracts.clamp_to_schema("grounding", doc)
        if not contracts.is_valid("grounding", doc):
            raise ValueError(f"grounding failed schema: {json.dumps(doc)[:200]}")
        return doc


class LiveInpainter:
    """muse-image-1.0 has no mask input and regenerates its whole input image, so: crop the
    neighborhood of the region, paint the region magenta, ask for a fill, align the result to the
    crop and composite only inside the region. Falls back to free Telea inpainting on any failure."""

    def __init__(self, api: MetaModelAPI, ledger: SpendLedger, cache: DevCache) -> None:
        self.api, self.ledger, self.cache = api, ledger, cache

    async def remove(self, plate, region, label):
        x0, y0, x1, y1 = vision.edit_crop(region)
        crop, crop_region = plate[y0:y1, x0:x1], region[y0:y1, x0:x1]
        marked = await asyncio.to_thread(lambda: vision.encode_jpeg(vision.mark_region(crop, crop_region), 92))
        prompt = (
            "Repaint the solid magenta area so it shows the background that would be behind it, matching the "
            "surrounding scene, lighting and perspective. Remove anything magenta. Change nothing outside the magenta area."
        )
        key = request_key("muse-image-1.0", prompt, marked)
        try:
            edited = self.cache.get(key)
            if edited is None:
                self.ledger.check(IMAGE_PER_EDIT)
                edited = await self.api.image_edit(marked, prompt)
                self.ledger.charge("muse-image-1.0", IMAGE_PER_EDIT, label=label or "")
                self.cache.put(key, edited)
            def finish():
                aligned, _ = vision.align_to(crop, vision.decode_image(edited), crop_region)
                out = plate.copy()
                out[y0:y1, x0:x1] = vision.composite(crop, aligned, crop_region)
                return out

            return InpaintResult(await asyncio.to_thread(finish), "muse")
        except Exception:
            # SpendCapExceeded included: a free local fill beats a hole in the background.
            return InpaintResult(await asyncio.to_thread(vision.telea_fill, plate, region), "telea")


def build_adapters(settings, ledger: SpendLedger, cache: DevCache) -> Adapters:
    if settings.adapters != "live":
        return Adapters(FakeSegmenter(), FakeGrounder(), FakeInpainter(), live=False, mutator=FakeMutator())
    api = MetaModelAPI(settings.model_api_key, settings.model_api_base)
    return Adapters(
        LiveSegmenter(api, ledger, cache),
        LiveGrounder(api, ledger, cache, settings.grounding_effort),
        LiveInpainter(api, ledger, cache),
        live=True,
        mutator=LiveMutator(api, ledger, cache, settings.codegen_effort),
    )
