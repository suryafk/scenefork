import cv2
import numpy as np

from app import vision
from tests.conftest import TRUCK_BOX


def truck_mask(scene):
    return vision.flood_mask(scene, 450, 420)


def test_flood_fake_segmenter_finds_the_truck_body(scene):
    m = truck_mask(scene)
    ys, xs = np.nonzero(m)
    # The fake blurs before filling, so edges can land a pixel or two inside.
    assert abs(xs.min() - TRUCK_BOX[0]) <= 2 and abs(ys.min() - TRUCK_BOX[1]) <= 2
    assert m[420, 450] and not m[100, 100]


def test_compile_object_produces_outline_sprite_and_inpaint_mask(scene):
    obj = vision.compile_object(scene, truck_mask(scene))
    assert obj is not None
    assert 4 <= len(obj.polygon_px) <= vision.MAX_POLYGON_VERTICES
    assert abs(obj.bbox["x"] - TRUCK_BOX[0]) <= 2 and abs(obj.bbox["y"] - TRUCK_BOX[1]) <= 2
    sprite = cv2.imdecode(np.frombuffer(obj.sprite_webp, np.uint8), cv2.IMREAD_UNCHANGED)
    assert sprite.shape == (obj.bbox["h"], obj.bbox["w"], 4)
    assert sprite[40, 40, 3] == 255  # inside the cargo box: opaque
    # The inpaint region covers the object plus a 15px halo and a shadow band below it.
    assert obj.inpaint_mask.sum() > obj.mask.sum()
    assert obj.inpaint_mask[obj.bbox["y"] - 10, 450]
    assert obj.inpaint_mask[obj.bbox["y"] + obj.bbox["h"] + 20, 540]  # between the wheels


def test_compile_object_rejects_empty_and_frame_filling_masks(scene):
    h, w = scene.shape[:2]
    assert vision.compile_object(scene, np.zeros((h, w), bool)) is None
    assert vision.compile_object(scene, np.ones((h, w), bool)) is None
    sky = vision.flood_mask(scene, 100, 100)  # 65% of the frame
    assert vision.compile_object(scene, sky) is None
    road = vision.flood_mask(scene, 200, 650)  # under 60%, but touches 3 frame edges
    assert road.mean() < vision.MAX_MASK_FRACTION
    assert vision.compile_object(scene, road) is None


def test_composite_never_touches_pixels_outside_the_region(scene):
    region = np.zeros(scene.shape[:2], bool)
    region[300:400, 300:500] = True
    patch = np.full_like(scene, 7)
    out = vision.composite(scene, patch, region)
    assert np.array_equal(out[~region], scene[~region])
    assert (out[350, 400] == 7).all()  # well inside: fully the patch


def test_align_recovers_a_reframed_edit():
    """Muse Image shifted the probe scene about 20px; alignment must undo that before pasting."""
    rng = np.random.default_rng(0)
    base = cv2.GaussianBlur((rng.random((360, 640, 3)) * 255).astype(np.uint8), (0, 0), 3)
    shifted = np.roll(base, 18, axis=0)  # the editor moved everything down 18px
    region = np.zeros(base.shape[:2], bool)
    region[150:220, 250:350] = True
    aligned, ok = vision.align_to(base, shifted, region)
    assert ok
    inner = (slice(40, 320), slice(40, 600))
    before = np.abs(shifted[inner].astype(int) - base[inner].astype(int)).mean()
    after = np.abs(aligned[inner].astype(int) - base[inner].astype(int)).mean()
    assert after < before / 4


def test_mark_region_paints_only_the_region(scene):
    region = np.zeros(scene.shape[:2], bool)
    region[10:20, 10:20] = True
    marked = vision.mark_region(scene, region)
    assert tuple(marked[15, 15]) == vision.MARKER_BGR
    assert np.array_equal(marked[~region], scene[~region])


def test_wide_strips_are_rejected_even_touching_one_edge(scene):
    # The live-test failure: a road+sidewalk strip from x=0 to about 79% of the width.
    h, w = scene.shape[:2]
    strip = np.zeros((h, w), bool)
    strip[495:690, 0:1010] = True
    assert vision.edges_touched(strip) == 1
    assert vision.compile_object(scene, strip) is None
    # The truck (25% of the width) still passes.
    assert vision.compile_object(scene, truck_mask(scene)) is not None


def test_edit_crop_keeps_context_and_stays_in_frame():
    region = np.zeros((720, 1280), bool)
    region[380:560, 380:700] = True  # the truck, 320x180
    x0, y0, x1, y1 = vision.edit_crop(region)
    assert (x1 - x0, y1 - y0) == (640, 360)  # 50% margin on each side
    assert x0 <= 380 and x1 >= 700 and y0 <= 380 and y1 >= 560
    corner = np.zeros((720, 1280), bool)
    corner[690:720, 1250:1280] = True  # tiny object in the corner
    x0, y0, x1, y1 = vision.edit_crop(corner)
    assert 0 <= x0 < x1 <= 1280 and 0 <= y0 < y1 <= 720
    assert x1 - x0 >= 256 and y1 - y0 >= 256
