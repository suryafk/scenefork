"""Phase 0 model reality check: one real call to each Meta Model API endpoint SceneFork uses.

Run from backend/:  uv run python scripts/probe_models.py
Reads MODEL_API_KEY from the environment or backend/.env. Writes raw outputs to
scripts/probe_out/ and prints a markdown summary for docs/model-probe.md.
"""

import base64
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import requests
from openai import OpenAI
from PIL import Image, ImageDraw

BASE_URL = "https://api.meta.ai/v1"
OUT = Path(__file__).parent / "probe_out"
W, H = 1280, 720
# Synthetic street scene: the truck's true box, used to score SAM.
TRUCK_BOX = (380, 380, 700, 560)
CONE_BOX = (880, 470, 960, 560)
SPOKEN = "make the gravity like the moon"


def load_key() -> str:
    key = os.environ.get("MODEL_API_KEY", "")
    env = Path(__file__).parent.parent / ".env"
    if not key and env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("MODEL_API_KEY="):
                key = line.split("=", 1)[1].strip().strip('"')
    if not key:
        sys.exit("MODEL_API_KEY is not set (export it or put it in backend/.env)")
    return key


def make_scene() -> bytes:
    img = Image.new("RGB", (W, H), (135, 190, 235))
    d = ImageDraw.Draw(img)
    d.rectangle((0, 480, W, H), fill=(90, 90, 95))  # road
    d.rectangle((0, 470, W, 480), fill=(170, 170, 160))  # curb
    x1, y1, x2, y2 = TRUCK_BOX
    d.rectangle((x1, y1, x2 - 90, y2 - 30), fill=(200, 30, 30))  # cargo box
    d.rectangle((x2 - 90, y1 + 50, x2, y2 - 30), fill=(170, 20, 20))  # cab
    d.rectangle((x2 - 70, y1 + 65, x2 - 15, y1 + 105), fill=(180, 220, 240))  # window
    for cx in (x1 + 60, x2 - 50):
        d.ellipse((cx - 30, y2 - 60, cx + 30, y2), fill=(25, 25, 25))
    cx1, cy1, cx2, cy2 = CONE_BOX
    d.polygon([((cx1 + cx2) // 2, cy1), (cx1, cy2), (cx2, cy2)], fill=(250, 130, 20))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def data_url(png: bytes, mime: str = "image/png") -> str:
    return f"data:{mime};base64,{base64.b64encode(png).decode()}"


def iou(a, b) -> float:
    ix1, iy1, ix2, iy2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    area = lambda r: (r[2] - r[0]) * (r[3] - r[1])
    return inter / max(area(a) + area(b) - inter, 1)


def timed(fn):
    t0 = time.perf_counter()
    try:
        detail = fn()
        return {"ok": True, "ms": round((time.perf_counter() - t0) * 1000), **detail}
    except Exception as e:  # record every failure; the probe's job is to report, not to stop
        body = getattr(getattr(e, "response", None), "text", "")
        return {"ok": False, "ms": round((time.perf_counter() - t0) * 1000), "error": f"{type(e).__name__}: {e}"[:400], "body": body[:400]}


def stream_sam(key: str, prompt: str, image_url: str) -> str:
    r = requests.post(
        f"{BASE_URL}/responses",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "Accept": "text/event-stream"},
        json={
            "model": "sam-3.1",
            "input": [{"type": "message", "role": "user", "content": [
                {"type": "input_text", "text": prompt},
                {"type": "input_image", "image_url": image_url},
            ]}],
            "stream": True,
        },
        stream=True,
        timeout=60,
    )
    r.raise_for_status()
    text = []
    for raw in r.iter_lines():
        if not raw or not raw.startswith(b"data: "):
            continue
        data = raw[6:].decode("utf-8", "replace")
        if data == "[DONE]":
            break
        event = json.loads(data)
        if event.get("type") == "response.output_text.delta":
            text.append(event.get("delta", ""))
    return "".join(text)


def parse_boxes(sam_text: str) -> list[dict]:
    out = []
    for m in re.finditer(r"(\d+)<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);[^|]*\|><\|mask;[^|]*?data=(\d+),(\d+),(.)", sam_text):
        oid, x1, y1, x2, y2, mh, mw, enc = m.groups()
        out.append({"id": int(oid), "box": [int(x1), int(y1), int(x2), int(y2)], "mask_hw": [int(mh), int(mw)], "mask_enc": enc})
    return out


def main() -> None:
    key = load_key()
    OUT.mkdir(exist_ok=True)
    client = OpenAI(base_url=BASE_URL, api_key=key)
    scene = make_scene()
    (OUT / "scene.png").write_bytes(scene)
    scene_url = data_url(scene)
    results = {}

    def models():
        ids = sorted(m.id for m in client.models.list().data)
        return {"models": ids}

    results["models.list"] = timed(models)

    def spark_grounding():
        schema = {
            "type": "object",
            "properties": {
                "label": {"type": "string"},
                "body_type": {"type": "string", "enum": ["dynamic", "fixed"]},
                "mass_kg": {"type": "number"},
                "restitution": {"type": "number"},
                "friction": {"type": "number"},
                "acoustic_material": {"type": "string", "enum": ["hollow_metal", "solid_metal", "glass", "ceramic", "wood", "rubber", "plastic", "flesh_cloth", "concrete", "water"]},
            },
            "required": ["label", "body_type", "mass_kg", "restitution", "friction", "acoustic_material"],
            "additionalProperties": False,
        }
        x1, y1, x2, y2 = TRUCK_BOX
        r = client.chat.completions.create(
            model="muse-spark-1.3",
            messages=[{"role": "user", "content": [
                {"type": "text", "text": f"The object inside the box x1={x1},y1={y1},x2={x2},y2={y2} (pixels, image {W}x{H}) will become a 2D rigid body. Estimate its real-world physics."},
                {"type": "image_url", "image_url": {"url": scene_url}},
            ]}],
            response_format={"type": "json_schema", "json_schema": {"name": "Grounding", "schema": schema, "strict": True}},
        )
        return {"grounding": json.loads(r.choices[0].message.content), "usage": r.usage.model_dump() if r.usage else None}

    results["muse-spark-1.3 grounding (json_schema + image)"] = timed(spark_grounding)

    def sam_point():
        x1, y1, x2, y2 = TRUCK_BOX
        px, py = (x1 + x2) // 2 - 40, (y1 + y2) // 2 - 20
        text = stream_sam(key, f"<0f>1<|point;x={px};y={py};w={W};h={H}|>", scene_url)
        (OUT / "sam_point.txt").write_text(text)
        recs = parse_boxes(text)
        best = max((iou(r["box"], TRUCK_BOX) for r in recs), default=0.0)
        return {"records": recs, "truck_iou": round(best, 3)}

    results["sam-3.1 point prompt (click on truck)"] = timed(sam_point)

    def sam_concept():
        text = stream_sam(key, "red truck", scene_url)
        (OUT / "sam_concept.txt").write_text(text)
        recs = parse_boxes(text)
        return {"records": recs, "truck_iou": round(max((iou(r["box"], TRUCK_BOX) for r in recs), default=0.0), 3)}

    results["sam-3.1 concept prompt ('red truck')"] = timed(sam_concept)

    def image_edit():
        r = requests.post(
            f"{BASE_URL}/images/edits",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={
                "model": "muse-image-1.0",
                "prompt": "Remove the red truck completely and fill its area with the empty road, curb and sky that would be behind it. Keep every other pixel unchanged.",
                "images": [{"image_url": scene_url}],
                "n": 1,
            },
            timeout=180,
        )
        r.raise_for_status()
        item = r.json()["data"][0]
        raw = base64.b64decode(item["b64_json"]) if item.get("b64_json") else requests.get(item["url"], timeout=60).content
        (OUT / "edit_result.img").write_bytes(raw)
        out = Image.open(io.BytesIO(raw)).convert("RGB")
        size = list(out.size)
        src = Image.open(io.BytesIO(scene)).convert("RGB")
        if out.size != src.size:
            out = out.resize(src.size)
        # How much did the edit change pixels OUTSIDE the truck? (0 = untouched)
        diff, n = 0, 0
        for y in range(0, H, 8):
            for x in range(0, W, 8):
                if TRUCK_BOX[0] - 20 <= x <= TRUCK_BOX[2] + 20 and TRUCK_BOX[1] - 20 <= y <= TRUCK_BOX[3] + 20:
                    continue
                a, b = src.getpixel((x, y)), out.getpixel((x, y))
                diff += sum(abs(i - j) for i, j in zip(a, b)) / 3
                n += 1
        tx, ty = (TRUCK_BOX[0] + TRUCK_BOX[2]) // 2, (TRUCK_BOX[1] + TRUCK_BOX[3]) // 2
        return {"output_size": size, "format": Image.open(io.BytesIO(raw)).format, "bytes": len(raw), "mean_abs_diff_outside_truck": round(diff / max(n, 1), 2), "truck_center_rgb_after": out.getpixel((tx - 40, ty - 20))}

    results["muse-image-1.0 edit (remove truck)"] = timed(image_edit)

    def asr():
        with tempfile.TemporaryDirectory() as td:
            aiff, wav = Path(td) / "s.aiff", Path(td) / "s.wav"
            subprocess.run(["say", "-o", str(aiff), SPOKEN], check=True)
            subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@24000", "-c", "1", str(aiff), str(wav)], check=True)
            r = requests.post(
                f"{BASE_URL}/asr/transcribe",
                params={"sessionId": f"probe-{int(time.time())}"},
                headers={"Authorization": f"Bearer {key}"},
                files={
                    "request": (None, json.dumps({"mode": "PUSH_TO_TALK", "model": "muse-voice-transcribe-1.0", "audioEncoding": "WAV"}), "application/json"),
                    "audio": ("s.wav", wav.read_bytes(), "audio/wav"),
                },
                timeout=60,
            )
        r.raise_for_status()
        return {"expected": SPOKEN, "response": r.json() if "json" in r.headers.get("content-type", "") else r.text[:300]}

    results["muse-voice-transcribe-1.0 file (push-to-talk)"] = timed(asr)

    (OUT / "results.json").write_text(json.dumps(results, indent=2, default=str))
    print("| Probe | OK | Latency | Notes |\n|---|---|---|---|")
    for name, r in results.items():
        note = {k: v for k, v in r.items() if k not in ("ok", "ms")}
        print(f"| {name} | {'yes' if r['ok'] else 'NO'} | {r['ms']} ms | `{json.dumps(note, default=str)[:300]}` |")


if __name__ == "__main__":
    main()
