"""Golden-clip export (eng review OV1, OV6, OV9): run a fork frame through the models once, offline,
and write static files the browser plays with no backend.

    frontend/public/golden/
      index.json                       every clip and fork point (StaticGoldenSource reads this)
      <clip_id>/<fork_index>/
        manifest.json                  shared/golden.schema.json
        frame.jpg                      the fork frame
        <obj>_sprite.webp              the object, alpha-cut
        <obj>_patch.webp               clean background under the object, alpha = dilated region

Each patch comes from inpainting the ORIGINAL frame for that object alone. Because the composite
leaves every pixel outside the region untouched, the browser can stack patches for any set of
freed objects in any order. Patches are plain files so they can be touched up by hand (OV9).
"""

import json
import statistics
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from . import contracts, vision
from .adapters import Adapters

#: OV6: per-clip scale from grounding, clamped.
MIN_PPM, MAX_PPM, DEFAULT_PPM = 30.0, 600.0, 100.0
PATCH_FEATHER_PX = 4


@dataclass
class ExportedObject:
    doc: dict
    files: dict[str, bytes] = field(default_factory=dict)


def video_frame(path: Path, t_s: float) -> np.ndarray:
    """One frame of a video at t seconds (the browser decodes for live forks; this is offline only)."""
    cap = cv2.VideoCapture(str(path))
    try:
        cap.set(cv2.CAP_PROP_POS_MSEC, t_s * 1000)
        ok, frame = cap.read()
    finally:
        cap.release()
    if not ok:
        raise ValueError(f"couldn't read a frame at {t_s}s from {path} (try exporting the frame as PNG and use --image)")
    return frame


def fit_frame(frame: np.ndarray, max_side: int = 1280) -> np.ndarray:
    h, w = frame.shape[:2]
    if max(h, w) <= max_side:
        return frame
    s = max_side / max(h, w)
    return cv2.resize(frame, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA)


def patch_image(plate: np.ndarray, region: np.ndarray) -> tuple[bytes, dict]:
    """The cleaned pixels over the region's bounding box, with a soft alpha edge."""
    grown = cv2.dilate(region.astype(np.uint8), np.ones((3, 3), np.uint8), iterations=PATCH_FEATHER_PX)
    ys, xs = np.nonzero(grown)
    x0, y0, x1, y1 = int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
    alpha = cv2.GaussianBlur(grown.astype(np.float32) * 255, (0, 0), PATCH_FEATHER_PX / 2)
    alpha = np.maximum(alpha, region.astype(np.float32) * 255)  # fully opaque inside the region
    bgra = np.dstack([plate[y0:y1, x0:x1], alpha[y0:y1, x0:x1].clip(0, 255).astype(np.uint8)])
    # Lossless: lossy WebP subsamples color, and these files get hand-touched (OV9).
    return vision.encode_webp(bgra, 101), {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}


def pixels_per_meter(objects: list[dict]) -> float:
    """OV6: median(px height / real height) over grounded dynamic objects, clamped 30-600."""
    ratios = [
        o["sprite_bbox"]["h"] / o["grounding"]["approx_height_m"]
        for o in objects
        if o["grounding"]["body_type"] == "dynamic" and o["grounding"]["approx_height_m"] > 0.05
    ]
    if not ratios:
        return DEFAULT_PPM
    return round(min(max(statistics.median(ratios), MIN_PPM), MAX_PPM), 1)


async def export_fork(adapters: Adapters, frame: np.ndarray, clicks: list[tuple[int, int]], log=print) -> tuple[list[ExportedObject], list[str]]:
    """Free every clicked object from the original frame. Returns the objects and any skipped clicks."""
    jpeg = vision.encode_jpeg(frame, 92)
    taken = np.zeros(frame.shape[:2], bool)
    out: list[ExportedObject] = []
    skipped: list[str] = []
    for x, y in clicks:
        if taken[y, x]:
            skipped.append(f"({x}, {y}) is inside an object already exported")
            continue
        mask = await adapters.segmenter.segment(frame, jpeg, x, y)
        obj = vision.compile_object(frame, mask) if mask is not None else None
        if obj is None:
            skipped.append(f"({x}, {y}) found no object (empty, tiny, or background-sized mask)")
            continue
        taken |= obj.mask
        oid = f"obj_{len(out) + 1}"
        grounding = contracts.pin_background(await adapters.grounder.ground(frame, obj))
        result = await adapters.inpainter.remove(frame, obj.inpaint_mask, grounding["label"])
        patch, patch_bbox = patch_image(result.plate, obj.inpaint_mask)
        log(f"  {oid}: {grounding['label']} ({grounding['body_type']}, {grounding['mass_kg']:g} kg), plate via {result.method}")
        out.append(
            ExportedObject(
                {
                    "id": oid,
                    "click": [x, y],
                    "label": grounding["label"],
                    "polygon_px": obj.polygon_px,
                    "sprite": f"{oid}_sprite.webp",
                    "sprite_bbox": obj.bbox,
                    "patch": f"{oid}_patch.webp",
                    "patch_bbox": patch_bbox,
                    "plate_method": result.method,
                    "grounding": grounding,
                },
                {f"{oid}_sprite.webp": obj.sprite_webp, f"{oid}_patch.webp": patch},
            )
        )
    return out, skipped


def write_fork(
    out_dir: Path,
    clip_id: str,
    title: str,
    fork_index: int,
    t_fork: float,
    frame: np.ndarray,
    objects: list[ExportedObject],
    ppm: float | None = None,
    video: str | None = None,
) -> dict:
    """Write one fork point's files and update index.json. Returns the manifest."""
    h, w = frame.shape[:2]
    docs = [o.doc for o in objects]
    manifest = {
        "clip_id": clip_id,
        "title": title,
        "fork_index": fork_index,
        "t_fork": t_fork,
        "width": w,
        "height": h,
        "pixels_per_meter": ppm if ppm is not None else pixels_per_meter(docs),
        "ground_material": "concrete",
        "frame": "frame.jpg",
        "objects": docs,
    }
    if not contracts.is_valid("golden", manifest):
        raise ValueError("manifest failed shared/golden.schema.json")
    fork_dir = out_dir / clip_id / str(fork_index)
    fork_dir.mkdir(parents=True, exist_ok=True)
    for stale in fork_dir.glob("obj_*"):
        stale.unlink()
    (fork_dir / "frame.jpg").write_bytes(vision.encode_jpeg(frame, 92))
    for o in objects:
        for name, data in o.files.items():
            (fork_dir / name).write_bytes(data)
    (fork_dir / "manifest.json").write_text(json.dumps(manifest, indent=1))

    index_path = out_dir / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {"clips": []}
    clip = next((c for c in index["clips"] if c["clip_id"] == clip_id), None)
    if clip is None:
        clip = {"clip_id": clip_id, "title": title, "forks": []}
        index["clips"].append(clip)
    clip["title"] = title
    if video:
        clip["video"] = video
    clip["forks"] = sorted(
        [f for f in clip["forks"] if f["fork_index"] != fork_index]
        + [{"fork_index": fork_index, "t_fork": t_fork, "manifest": f"{clip_id}/{fork_index}/manifest.json"}],
        key=lambda f: f["fork_index"],
    )
    index_path.write_text(json.dumps(index, indent=1))
    return manifest
