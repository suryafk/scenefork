"""Pixel work between the models and the physics: masks to outlines and sprites, and clean-plate compositing.

All images are OpenCV BGR uint8 arrays in frame pixels; masks are bool arrays of the frame's shape.
"""

from dataclasses import dataclass

import cv2
import numpy as np

#: Masks covering more than this share of the frame are rejected (design: "a mask over 60%").
MAX_MASK_FRACTION = 0.60
#: Masks wider than this share of the frame are ground, sidewalk or sky strips, not objects
#: (Phase 2 live test: a click on the road returned a 79%-wide road+sidewalk strip).
MAX_MASK_WIDTH_FRACTION = 0.75
#: Context kept around the region when cropping for Muse Image, as a share of the region's size.
EDIT_CROP_MARGIN = 0.5
EDIT_CROP_MIN_SIDE = 256
MIN_MASK_PIXELS = 150
MAX_POLYGON_VERTICES = 48
#: Dilation for the inpaint mask, so drop-shadows and compression halos go too (blueprint: 15px).
INPAINT_DILATION_PX = 15
SHADOW_BAND_PX = 12
#: Fill color that marks the region Muse Image must repaint.
MARKER_BGR = (255, 0, 255)


@dataclass
class CompiledObject:
    polygon_px: list[list[int]]
    bbox: dict[str, int]
    sprite_webp: bytes
    mask: np.ndarray
    inpaint_mask: np.ndarray
    area_px: int


def decode_image(data: bytes) -> np.ndarray:
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("could not decode image")
    return img


def encode_jpeg(img: np.ndarray, quality: int = 90) -> bytes:
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    assert ok
    return buf.tobytes()


def encode_webp(img: np.ndarray, quality: int = 90) -> bytes:
    """quality 101 is lossless (used for sprites, which carry alpha)."""
    ok, buf = cv2.imencode(".webp", img, [cv2.IMWRITE_WEBP_QUALITY, quality])
    assert ok
    return buf.tobytes()


def largest_component(mask: np.ndarray) -> np.ndarray:
    m = mask.astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    if n <= 1:
        return np.zeros_like(mask, dtype=bool)
    best = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return labels == best


def edges_touched(mask: np.ndarray) -> int:
    return int(mask[0].any()) + int(mask[-1].any()) + int(mask[:, 0].any()) + int(mask[:, -1].any())


def simplify_outline(mask: np.ndarray) -> list[list[int]]:
    contours, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    contour = max(contours, key=cv2.contourArea)
    perimeter = cv2.arcLength(contour, True)
    eps = 0.003 * perimeter
    approx = cv2.approxPolyDP(contour, eps, True)
    while len(approx) > MAX_POLYGON_VERTICES:
        eps *= 1.4
        approx = cv2.approxPolyDP(contour, eps, True)
    return [[int(p[0][0]), int(p[0][1])] for p in approx]


def inpaint_region(mask: np.ndarray) -> np.ndarray:
    """Dilated mask plus a short band below the object for its cast shadow."""
    m = mask.astype(np.uint8)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * INPAINT_DILATION_PX + 1, 2 * INPAINT_DILATION_PX + 1))
    dilated = cv2.dilate(m, k)
    shadow = np.zeros_like(m)
    shadow[SHADOW_BAND_PX:] = m[:-SHADOW_BAND_PX]
    return (dilated | cv2.dilate(shadow, k)).astype(bool)


def compile_object(frame: np.ndarray, raw_mask: np.ndarray) -> CompiledObject | None:
    """SAM mask to outline, sprite and inpaint mask. None when the mask is unusable."""
    h, w = raw_mask.shape
    mask = largest_component(raw_mask)
    area = int(mask.sum())
    if area < MIN_MASK_PIXELS or area > MAX_MASK_FRACTION * h * w:
        return None
    if edges_touched(mask) >= 3:
        return None  # ground, sky or a wall: background, not a throwable object
    _, _, bw, _ = cv2.boundingRect(mask.astype(np.uint8))
    if bw > MAX_MASK_WIDTH_FRACTION * w:
        return None  # a strip spanning the frame: road, sidewalk or sky
    polygon = simplify_outline(mask)
    if len(polygon) < 3:
        return None
    x, y, bw, bh = cv2.boundingRect(mask.astype(np.uint8))
    alpha = (mask[y : y + bh, x : x + bw] * 255).astype(np.uint8)
    alpha = cv2.GaussianBlur(alpha, (3, 3), 0)  # soften the cut edge by about a pixel
    sprite = np.dstack([frame[y : y + bh, x : x + bw], alpha])
    return CompiledObject(
        polygon_px=polygon,
        bbox={"x": x, "y": y, "w": bw, "h": bh},
        sprite_webp=encode_webp(sprite, 101),
        mask=mask,
        inpaint_mask=inpaint_region(mask),
        area_px=area,
    )


def edit_crop(region: np.ndarray, margin: float = EDIT_CROP_MARGIN, min_side: int = EDIT_CROP_MIN_SIDE) -> tuple[int, int, int, int]:
    """Box (x0, y0, x1, y1) around `region` with context on every side, clamped to the frame.

    Muse Image regenerates its whole input (Phase 2 live test: buildings re-laid out, other
    objects moved or deleted), so it only gets this neighborhood to repaint, not the frame.
    """
    h, w = region.shape
    x, y, bw, bh = cv2.boundingRect(region.astype(np.uint8))
    cw = max(int(bw * (1 + 2 * margin)), min(min_side, w))
    ch = max(int(bh * (1 + 2 * margin)), min(min_side, h))
    cx, cy = x + bw / 2, y + bh / 2
    x0 = int(min(max(cx - cw / 2, 0), w - cw))
    y0 = int(min(max(cy - ch / 2, 0), h - ch))
    return max(x0, 0), max(y0, 0), min(x0 + cw, w), min(y0 + ch, h)


def mark_region(plate: np.ndarray, region: np.ndarray) -> np.ndarray:
    """Paint the region to remove in the marker color, for an instruction-only image editor."""
    out = plate.copy()
    out[region] = MARKER_BGR
    return out


def align_to(base: np.ndarray, edited: np.ndarray, region: np.ndarray) -> tuple[np.ndarray, bool]:
    """Warp `edited` onto `base` with an affine fit on the pixels outside `region`.

    Muse Image re-renders and slightly re-frames the whole image (about 20px in the Phase 0
    probe), so pasting it back unaligned leaves seams wherever a line crosses the mask edge.
    """
    h, w = base.shape[:2]
    edited = cv2.resize(edited, (w, h), interpolation=cv2.INTER_AREA)
    scale = 0.5
    small = lambda im: cv2.resize(cv2.cvtColor(im, cv2.COLOR_BGR2GRAY), None, fx=scale, fy=scale).astype(np.float32)
    keep = cv2.resize((~region).astype(np.uint8), None, fx=scale, fy=scale, interpolation=cv2.INTER_NEAREST)
    warp = np.eye(2, 3, dtype=np.float32)
    try:
        criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 80, 1e-5)
        _, warp = cv2.findTransformECC(small(base), small(edited), warp, cv2.MOTION_AFFINE, criteria, keep, 5)
    except cv2.error:
        return edited, False
    warp[:, 2] /= scale
    aligned = cv2.warpAffine(edited, warp, (w, h), flags=cv2.INTER_LINEAR + cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)
    return aligned, True


def composite(base: np.ndarray, patch: np.ndarray, region: np.ndarray, feather_px: int = 10) -> np.ndarray:
    """Take `patch` inside `region` (feathered), `base` everywhere else: pixels outside never change."""
    # Feather inward only: the blur ramps from 0.5 at the region edge to 1 inside, doubled and
    # clipped, then zeroed outside, so the frame outside the region stays pixel-exact.
    blur = cv2.GaussianBlur(region.astype(np.float32), (0, 0), feather_px / 2)
    alpha = (np.clip(blur * 2.0 - 1.0, 0, 1) * region)[..., None]
    return (patch.astype(np.float32) * alpha + base.astype(np.float32) * (1 - alpha)).astype(np.uint8)


def telea_fill(plate: np.ndarray, region: np.ndarray) -> np.ndarray:
    """Free local inpainting: the fallback when the Muse edit fails, and the fake adapter's fill."""
    return cv2.inpaint(plate, region.astype(np.uint8) * 255, 7, cv2.INPAINT_TELEA)


def flood_mask(frame: np.ndarray, x: int, y: int, tolerance: int = 18) -> np.ndarray:
    """Fake segmenter: the color region around the click (good on flat test scenes, free)."""
    h, w = frame.shape[:2]
    blurred = cv2.GaussianBlur(frame, (5, 5), 0)
    ff = np.zeros((h + 2, w + 2), np.uint8)
    flags = 4 | cv2.FLOODFILL_FIXED_RANGE | cv2.FLOODFILL_MASK_ONLY | (255 << 8)
    cv2.floodFill(blurred, ff, (int(x), int(y)), 0, (tolerance,) * 3, (tolerance,) * 3, flags)
    return ff[1:-1, 1:-1] > 0


def outlined_view(frame: np.ndarray, obj: CompiledObject, max_side: int = 768) -> bytes:
    """Frame with the freed object outlined, downscaled to save image tokens for grounding."""
    view = frame.copy()
    pts = np.array(obj.polygon_px, np.int32).reshape(-1, 1, 2)
    cv2.polylines(view, [pts], True, (0, 255, 255), 3)
    s = min(1.0, max_side / max(view.shape[:2]))
    if s < 1:
        view = cv2.resize(view, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    return encode_jpeg(view, 85)
