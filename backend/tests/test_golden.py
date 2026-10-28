"""Golden export with fake adapters: files, patches that stack in any order, OV6 scale, index merge."""

import asyncio
import json

import cv2
import numpy as np

from app import contracts, golden, vision
from app.adapters import build_adapters
from app.devcache import DevCache
from app.spend import SpendLedger
from tests.conftest import street_scene

TRUCK, CONE = (450, 420), (920, 530)


def export(settings, clicks):
    frame = street_scene()
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
    frame, (objects, skipped) = export(settings, [TRUCK, CONE, (460, 430)])
    assert [o.doc["id"] for o in objects] == ["obj_1", "obj_2"]
    assert skipped == ["(460, 430) is inside an object already exported"]
    manifest = golden.write_fork(tmp_path, "street_01", "Street", 0, 1.5, frame, objects)
    assert contracts.is_valid("golden", manifest)
    for o in manifest["objects"]:
        assert contracts.is_valid("grounding", o["grounding"])
    fork_dir = tmp_path / "street_01" / "0"
    assert {p.name for p in fork_dir.iterdir()} == {
        "manifest.json", "frame.jpg", "obj_1_sprite.webp", "obj_1_patch.webp", "obj_2_sprite.webp", "obj_2_patch.webp"
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
    frame, (objects, _) = export(settings, [TRUCK, CONE])
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
