"""PhysicsGrounder eval (eng review D11, OV11): re-ground every golden object and check it.

    cd backend && SCENEFORK_ADAPTERS=live uv run python scripts/eval_grounding.py

Cases: evals/grounding_cases.json. Each object is rebuilt from the golden frame and its exported
outline, then grounded by the live adapter (Muse Spark, through the SpendLedger and dev cache: the
first run costs about $0.0015 per object, re-runs are free). Results: evals/results/.
"""

import asyncio
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import vision  # noqa: E402
from app.adapters import build_adapters  # noqa: E402
from app.config import REPO_DIR, load_settings  # noqa: E402
from app.devcache import DevCache  # noqa: E402
from app.spend import SpendLedger  # noqa: E402

GOLDEN = REPO_DIR / "frontend" / "public" / "golden"
BAR = 0.9


def check(case: dict, g: dict) -> list[str]:
    problems = []
    label = g["label"].lower()
    if not any(w in label for w in case["class"]):
        problems.append(f"label '{g['label']}' is not one of {case['class']}")
    lo, hi = case["mass_kg"]
    if not lo <= g["mass_kg"] <= hi:
        problems.append(f"mass {g['mass_kg']:g} kg outside {lo}-{hi}")
    if g["body_type"] != case["body_type"]:
        problems.append(f"body_type {g['body_type']}, expected {case['body_type']}")
    return problems


async def main() -> int:
    settings = load_settings()
    if settings.adapters != "live":
        print("Set SCENEFORK_ADAPTERS=live: the eval measures the real model.", file=sys.stderr)
        return 2
    ledger = SpendLedger(settings.spend_dir, settings.spend_cap_usd)
    before = ledger.total_usd
    grounder = build_adapters(settings, ledger, DevCache(settings.cache_dir, settings.dev_cache)).grounder
    cases = json.loads((REPO_DIR / "evals" / "grounding_cases.json").read_text())["cases"]
    rows = []
    for case in cases:
        fork_dir = GOLDEN / case["fork"]
        manifest = json.loads((fork_dir / "manifest.json").read_text())
        frame = cv2.imread(str(fork_dir / manifest["frame"]))
        obj_doc = next(o for o in manifest["objects"] if o["id"] == case["object"])
        mask = np.zeros(frame.shape[:2], np.uint8)
        cv2.fillPoly(mask, [np.array(obj_doc["polygon_px"], np.int32)], 1)
        obj = vision.compile_object(frame, mask.astype(bool))
        t0 = time.perf_counter()
        g = await grounder.ground(frame, obj)
        problems = check(case, g)
        rows.append({"case": case, "grounding": g, "problems": problems, "ms": round((time.perf_counter() - t0) * 1000)})
        print(f"{'PASS' if not problems else 'FAIL'} {case['fork']} {case['object']}: {g['label']}, {g['mass_kg']:g} kg, {g['acoustic_material']}, {g['body_type']}"
              + (f"  ({'; '.join(problems)})" if problems else ""))
    passed = sum(1 for r in rows if not r["problems"])
    spent = ledger.total_usd - before
    lines = [
        f"# Grounding eval, {time.strftime('%Y-%m-%d %H:%M', time.gmtime())} UTC",
        "",
        f"muse-spark-1.3, reasoning_effort={settings.grounding_effort}; bar {int(BAR * 100)}%.",
        "",
        "| Object | Label | Mass | Material | Body | Result |",
        "|---|---|---|---|---|---|",
        *[
            f"| {r['case']['fork']} {r['case']['object']} | {r['grounding']['label']} | {r['grounding']['mass_kg']:g} kg | {r['grounding']['acoustic_material']} | {r['grounding']['body_type']} | "
            + ("✅" if not r["problems"] else "❌ " + "; ".join(r["problems"]))
            + " |"
            for r in rows
        ],
        "",
        f"Overall: {passed}/{len(rows)} objects pass ({passed / max(len(rows), 1):.0%}, bar {BAR:.0%}): {'✅ meets the bar' if passed >= BAR * len(rows) else '❌ below the bar'}. Spend: ${spent:.4f}.",
    ]
    out = REPO_DIR / "evals" / "results"
    out.mkdir(parents=True, exist_ok=True)
    (out / "grounding-latest.md").write_text("\n".join(lines) + "\n")
    (out / f"grounding-{time.strftime('%Y-%m-%dT%H-%M-%S', time.gmtime())}.json").write_text(json.dumps(rows, indent=1))
    print("\n" + "\n".join(lines))
    return 0 if passed >= BAR * len(rows) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
