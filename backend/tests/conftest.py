from dataclasses import replace
from pathlib import Path

import cv2
import numpy as np
import pytest

from app.config import Settings

FIXTURES = Path(__file__).parent / "fixtures"
W, H = 1280, 720
TRUCK_BOX = (380, 380, 700, 560)


def street_scene() -> np.ndarray:
    """The Phase 0 probe scene (BGR): sky, curb, road, red truck, orange cone."""
    img = np.zeros((H, W, 3), np.uint8)
    img[:] = (235, 190, 135)
    img[480:] = (95, 90, 90)
    img[470:480] = (160, 170, 170)
    x1, y1, x2, y2 = TRUCK_BOX
    cv2.rectangle(img, (x1, y1), (x2 - 90, y2 - 30), (30, 30, 200), -1)
    cv2.rectangle(img, (x2 - 90, y1 + 50), (x2, y2 - 30), (20, 20, 170), -1)
    cv2.rectangle(img, (x2 - 70, y1 + 65), (x2 - 15, y1 + 105), (240, 220, 180), -1)
    for cx in (x1 + 60, x2 - 50):
        cv2.circle(img, (cx, y2 - 30), 30, (25, 25, 25), -1)
    cv2.fillPoly(img, [np.array([[920, 470], [880, 560], [960, 560]], np.int32)], (20, 130, 250))
    return img


def sam_events(text: str) -> list[dict]:
    lane = {"item_id": "msg_1", "output_index": 0, "content_index": 0}
    return [
        {"type": "response.output_text.delta", "delta": text, **lane},
        {"type": "response.output_text.done", "text": text, **lane},
        {"type": "response.completed", "response": {"status": "completed"}},
    ]


@pytest.fixture
def scene() -> np.ndarray:
    return street_scene()


@pytest.fixture
def settings(tmp_path) -> Settings:
    return replace(
        Settings(),
        adapters="fake",
        spend_dir=tmp_path / "spend",
        cache_dir=tmp_path / "cache",
        spend_cap_usd=1.0,
        asset_secret=b"test-secret",
    )
