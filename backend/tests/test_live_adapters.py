"""Live adapters against stubbed API objects: real parsing, ledger and cache logic, zero credits."""

import asyncio

import cv2
import numpy as np
import pytest

from app import vision
from app.adapters import LiveGrounder, LiveInpainter, LiveSegmenter
from app.devcache import DevCache
from app.spend import IMAGE_PER_EDIT, SAM_PER_IMAGE, SpendCapExceeded, SpendLedger
from tests.conftest import FIXTURES, TRUCK_BOX, sam_events


class StubAPI:
    def __init__(self, sam_text="", spark=None, edit=None, fail_edit=False):
        self.sam_text, self.spark, self.edit, self.fail_edit = sam_text, spark, edit, fail_edit
        self.calls = {"sam": 0, "spark": 0, "edit": 0}

    async def sam_events(self, image_jpeg, prompt):
        self.calls["sam"] += 1
        assert prompt.startswith("<0f>1<|point;")
        return sam_events(self.sam_text)

    async def spark_json(self, model, effort, content, schema, name):
        self.calls["spark"] += 1
        assert model == "muse-spark-1.3" and effort == "minimal"
        return dict(self.spark), {"prompt_tokens": 1252, "completion_tokens": 266}

    async def image_edit(self, image_jpeg, prompt):
        self.calls["edit"] += 1
        self.edit_inputs = getattr(self, "edit_inputs", []) + [image_jpeg]
        if self.fail_edit:
            raise RuntimeError("upstream 500")
        return self.edit


def run(coro):
    return asyncio.run(coro)


def test_live_segmenter_decodes_the_real_sam_truck_mask_and_pays_once(tmp_path, scene):
    api = StubAPI(sam_text=(FIXTURES / "sam_truck_point.txt").read_text())
    ledger = SpendLedger(tmp_path / "s", 1.0)
    seg = LiveSegmenter(api, ledger, DevCache(tmp_path / "c", True))
    jpeg = vision.encode_jpeg(scene)
    mask = run(seg.segment(scene, jpeg, 500, 450))
    ys, xs = np.nonzero(mask)
    assert (xs.min(), ys.min()) == TRUCK_BOX[:2]
    assert abs(xs.max() - TRUCK_BOX[2]) <= 2 and abs(ys.max() - TRUCK_BOX[3]) <= 2
    assert ledger.total_usd == pytest.approx(SAM_PER_IMAGE)
    run(seg.segment(scene, jpeg, 500, 450))  # same click on the same frame: replayed from disk
    assert api.calls["sam"] == 1 and ledger.total_usd == pytest.approx(SAM_PER_IMAGE)


def test_live_segmenter_refuses_before_calling_when_the_cap_is_hit(tmp_path, scene):
    api = StubAPI(sam_text="")
    ledger = SpendLedger(tmp_path / "s", cap_usd=0.001)
    seg = LiveSegmenter(api, ledger, DevCache(tmp_path / "c", False))
    with pytest.raises(SpendCapExceeded):
        run(seg.segment(scene, vision.encode_jpeg(scene), 10, 10))
    assert api.calls["sam"] == 0


def test_live_grounder_clamps_model_output_into_the_contract(tmp_path, scene):
    api = StubAPI(spark={"label": "red truck", "body_type": "dynamic", "mass_kg": 40000, "restitution": 0.1,
                         "friction": 0.8, "acoustic_material": "hollow_metal", "approx_height_m": 2.8})
    ledger = SpendLedger(tmp_path / "s", 1.0)
    grounder = LiveGrounder(api, ledger, DevCache(tmp_path / "c", True), "minimal")
    obj = vision.compile_object(scene, vision.flood_mask(scene, 450, 420))
    g = run(grounder.ground(scene, obj))
    assert g["mass_kg"] == 5000 and g["label"] == "red truck"
    assert 0 < ledger.total_usd < 0.003


def test_live_inpainter_sends_only_a_crop_and_pastes_it_back(tmp_path, scene):
    region = vision.compile_object(scene, vision.flood_mask(scene, 450, 420)).inpaint_mask
    x0, y0, x1, y1 = vision.edit_crop(region)
    crop = scene[y0:y1, x0:x1].copy()
    clean = crop.copy()
    clean[region[y0:y1, x0:x1]] = vision.telea_fill(crop, region[y0:y1, x0:x1])[region[y0:y1, x0:x1]]
    # The editor returns the crop re-rendered bigger and shifted, like the live runs.
    reframed = cv2.resize(np.roll(clean, 8, axis=0), (2048, 1152))
    api = StubAPI(edit=vision.encode_jpeg(reframed, 95))
    ledger = SpendLedger(tmp_path / "s", 1.0)
    result = run(LiveInpainter(api, ledger, DevCache(tmp_path / "c", True)).remove(scene, region, "truck"))
    assert result.method == "muse"
    sent = vision.decode_image(api.edit_inputs[0])
    assert sent.shape[:2] == (y1 - y0, x1 - x0)  # Muse never sees the whole frame
    assert np.array_equal(result.plate[~region], scene[~region])  # nothing outside the region changes
    assert not np.array_equal(result.plate[region], scene[region])  # the truck is gone
    assert ledger.total_usd == pytest.approx(IMAGE_PER_EDIT)


def test_live_inpainter_falls_back_to_telea_for_free(tmp_path, scene):
    region = np.zeros(scene.shape[:2], bool)
    region[400:450, 400:450] = True
    api = StubAPI(fail_edit=True)
    ledger = SpendLedger(tmp_path / "s", 1.0)
    result = run(LiveInpainter(api, ledger, DevCache(tmp_path / "c", True)).remove(scene, region, None))
    assert result.method == "telea"
    assert ledger.total_usd == 0
