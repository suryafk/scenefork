"""Golden export with fake adapters: files, patches that stack in any order, OV6 scale, index merge."""

import asyncio
import json
from dataclasses import replace

import cv2
import numpy as np

from app import contracts, golden, vision
from app.adapters import InpaintResult, build_adapters
from app.devcache import DevCache
from app.spend import SpendLedger
from tests.conftest import street_scene

TRUCK, CONE = (450, 420), (920, 530)


def export(settings, clicks, frame=None):
    frame = street_scene() if frame is None else frame
    adapters = build_adapters(settings, SpendLedger(settings.spend_dir, 1.0), DevCache(settings.cache_dir, False))
    return frame, asyncio.run(golden.export_fork(adapters, frame, clicks, log=lambda *_: None))


def paste(base: np.ndarray, patch_webp: bytes, bbox: dict) -> np.ndarray:
    """What the browser does: alpha-blend a patch onto the plate."""
    bgra = cv2.imdecode(np.frombuffer(patch_webp, np.uint8), cv2.IMREAD_UNCHANGED)
    x, y, w, h = bbox["x"], bbox["y"], bbox["w"], bbox["h"]
    a = bgra[:, :, 3:4].astype(np.float32) / 255
    out = base.copy()
    out[y : y + h, x : x + w] = (bgra[:, :, :3] * a + base[y : y + h, x : x + w] * (1 - a)).astype(np.uint8)
    return out


def test_export_writes_a_valid_fork_and_index(settings, tmp_path):
    frame, (objects, skipped) = export(settings, [[TRUCK], [CONE], [(460, 430)]])
    assert [o.doc["id"] for o in objects] == ["obj_1", "obj_2"]
    assert skipped == ["(460, 430) is inside an object already exported"]
    manifest = golden.write_fork(tmp_path, "street_01", "Street", 0, 1.5, frame, objects)
    assert contracts.is_valid("golden", manifest)
    for o in manifest["objects"]:
        assert contracts.is_valid("grounding", o["grounding"])
    fork_dir = tmp_path / "street_01" / "0"
    assert {p.name for p in fork_dir.iterdir()} == {
        "manifest.json", "frame.jpg", *(f"obj_{i}_{k}.webp" for i in (1, 2) for k in ("sprite", "patch", "visible"))
    }
    index = json.loads((tmp_path / "index.json").read_text())
    assert index["clips"][0]["forks"] == [{"fork_index": 0, "t_fork": 1.5, "manifest": "street_01/0/manifest.json"}]

    # Re-exporting a second fork point merges into the index instead of replacing it.
    golden.write_fork(tmp_path, "street_01", "Street", 1, 4.0, frame, objects[:1])
    index = json.loads((tmp_path / "index.json").read_text())
    assert [f["fork_index"] for f in index["clips"][0]["forks"]] == [0, 1]


def test_a_pasted_patch_reproduces_the_plate_inside_the_region_only():
    frame = street_scene()
    region = np.zeros(frame.shape[:2], bool)
    region[400:500, 420:560] = True
    plate = frame.copy()
    plate[region] = (0, 255, 0)  # stand-in for the inpainted pixels
    webp, bbox = golden.patch_image(plate, region)
    out = paste(frame, webp, bbox)
    assert np.abs(out[region].astype(int) - plate[region].astype(int)).max() <= 1
    grown = cv2.dilate(region.astype(np.uint8), np.ones((3, 3), np.uint8), iterations=golden.PATCH_FEATHER_PX + 2).astype(bool)
    assert np.array_equal(out[~grown], frame[~grown])


def test_patches_stack_in_any_order(settings):
    frame, (objects, _) = export(settings, [[TRUCK], [CONE]])
    truck, cone = objects
    a = paste(paste(frame, truck.files["obj_1_patch.webp"], truck.doc["patch_bbox"]), cone.files["obj_2_patch.webp"], cone.doc["patch_bbox"])
    b = paste(paste(frame, cone.files["obj_2_patch.webp"], cone.doc["patch_bbox"]), truck.files["obj_1_patch.webp"], truck.doc["patch_bbox"])
    assert np.abs(a.astype(int) - b.astype(int)).max() <= 2  # the regions don't overlap here
    far = (slice(0, 300), slice(0, 300))
    assert np.array_equal(a[far], frame[far])


def test_scale_comes_from_grounded_heights_and_is_clamped():
    def obj(h_px, h_m, body="dynamic"):
        return {"sprite_bbox": {"x": 0, "y": 0, "w": 10, "h": h_px}, "grounding": {"approx_height_m": h_m, "body_type": body}}

    assert golden.pixels_per_meter([obj(180, 2.0), obj(80, 0.8), obj(300, 1.0, "fixed")]) == 95.0
    assert golden.pixels_per_meter([obj(5000, 1.0)]) == golden.MAX_PPM
    assert golden.pixels_per_meter([]) == golden.DEFAULT_PPM


def test_frames_are_fitted_to_1280():
    big = np.zeros((2160, 3840, 3), np.uint8)
    assert golden.fit_frame(big).shape[:2] == (720, 1280)
    assert vision.encode_jpeg(golden.fit_frame(big))


def stacked_scene() -> np.ndarray:
    """A blue box sitting on a wide orange box: touching objects, like a pot on books."""
    img = np.full((720, 1280, 3), (200, 200, 200), np.uint8)
    img[560:] = (120, 150, 180)
    cv2.rectangle(img, (500, 460), (800, 560), (40, 120, 230), -1)  # bottom (orange)
    cv2.rectangle(img, (600, 380), (700, 460), (200, 90, 30), -1)  # top (blue), resting on it
    return img


class WallInpainter:
    """A perfect fill for this scene: wall color above the floor line (tests the compositing, not Telea)."""

    async def remove(self, plate, region, label):
        out = plate.copy()
        out[region & (np.arange(720)[:, None] < 560)] = (200, 200, 200)
        out[region & (np.arange(720)[:, None] >= 560)] = (120, 150, 180)
        return InpaintResult(out, "wall")


def decode(webp: bytes) -> np.ndarray:
    return cv2.imdecode(np.frombuffer(webp, np.uint8), cv2.IMREAD_UNCHANGED)


def composite(frame, objects, freed: set[str]):
    """What the browser shows: the freed objects' patches in export order over the frame, each with
    the visible masks of the objects still standing cut out of it."""
    h, w = frame.shape[:2]
    standing = np.zeros((h, w), bool)
    for o in objects:
        if o.doc["id"] not in freed:
            vb = o.doc["visible_bbox"]
            standing[vb["y"] : vb["y"] + vb["h"], vb["x"] : vb["x"] + vb["w"]] |= decode(o.files[o.doc["visible"]])[:, :, 3] > 127
    out = frame.copy()
    for o in objects:  # export order
        if o.doc["id"] not in freed:
            continue
        b = o.doc["patch_bbox"]
        p = decode(o.files[o.doc["patch"]])
        a = p[:, :, 3:4].astype(np.float32) / 255 * ~standing[b["y"] : b["y"] + b["h"], b["x"] : b["x"] + b["w"], None]
        roi = out[b["y"] : b["y"] + b["h"], b["x"] : b["x"] + b["w"]]
        out[b["y"] : b["y"] + b["h"], b["x"] : b["x"] + b["w"]] = (p[:, :, :3] * a + roi * (1 - a)).astype(np.uint8)
    return out


def test_stacked_objects_clean_up_without_erasing_neighbors(settings):
    frame = stacked_scene()
    adapters = replace(build_adapters(settings, SpendLedger(settings.spend_dir, 1.0), DevCache(settings.cache_dir, False)), inpainter=WallInpainter())
    objects, _ = asyncio.run(golden.export_fork(adapters, frame, [[(650, 420)], [(650, 510)]], log=lambda *_: None))
    top_box, bottom_box = (slice(385, 455), slice(605, 695)), (slice(470, 550), slice(520, 780))
    # Freeing only the bottom box leaves the top box sitting there untouched, and vice versa.
    only_bottom = composite(frame, objects, {"obj_2"})
    assert np.array_equal(only_bottom[top_box], frame[top_box])
    assert not np.array_equal(only_bottom[bottom_box], frame[bottom_box])
    only_top = composite(frame, objects, {"obj_1"})
    assert np.array_equal(only_top[bottom_box], frame[bottom_box])
    # Both freed: no box color left.
    both = composite(frame, objects, {"obj_1", "obj_2"})
    box_pixels = lambda img: int(((np.abs(img.astype(int) - (40, 120, 230)).sum(2) < 40) | (np.abs(img.astype(int) - (200, 90, 30)).sum(2) < 40)).sum())  # noqa: E731
    assert box_pixels(frame) > 30_000 and box_pixels(both) < 300


ORANGE, BLUE, WALL = (40, 120, 230), (200, 90, 30), (200, 200, 200)


def layered(front: bool, back: bool) -> np.ndarray:
    """A blue card standing in front of a wide orange box (an airplane in front of a mug)."""
    img = np.full((720, 1280, 3), WALL, np.uint8)
    img[560:] = (120, 150, 180)
    if back:
        cv2.rectangle(img, (500, 400), (800, 559), ORANGE, -1)
    if front:
        cv2.rectangle(img, (620, 480), (700, 559), BLUE, -1)
    return img


class PaintBackInpainter:
    """The ideal fill: each removal reveals exactly what was behind (front first, then back)."""

    def __init__(self):
        self.targets = [layered(False, True), layered(False, False)]

    async def remove(self, plate, region, label):
        out = plate.copy()
        out[region] = self.targets.pop(0)[region]
        return InpaintResult(out, "ideal")


def test_occluded_objects_come_out_whole_and_every_combination_is_right(settings):
    frame = layered(True, True)
    adapters = replace(build_adapters(settings, SpendLedger(settings.spend_dir, 1.0), DevCache(settings.cache_dir, False)), inpainter=PaintBackInpainter())
    objects, _ = asyncio.run(golden.export_fork(adapters, frame, [[(660, 520)], [(560, 450)]], log=lambda *_: None))
    front, back = objects
    # The box behind is outlined whole, including the part the card hid.
    assert back.doc["sprite_bbox"]["h"] >= 155 and back.doc["sprite_bbox"]["w"] >= 295
    color = lambda img, c: int((np.abs(img.astype(int) - c).sum(2) < 30).sum())  # noqa: E731
    only_front = composite(frame, objects, {"obj_1"})
    assert color(only_front, BLUE) == 0  # the box shows through, whole
    assert np.abs(only_front.astype(int) - layered(False, True).astype(int)).max() <= 2
    only_back = composite(frame, objects, {"obj_2"})
    assert color(only_back, BLUE) >= color(frame, BLUE) - 10  # the card isn't cut (outlines round its corners)
    assert color(only_back, ORANGE) < 50
    both = composite(frame, objects, {"obj_1", "obj_2"})
    assert color(both, BLUE) == 0 and color(both, ORANGE) == 0
