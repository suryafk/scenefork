"""Export one golden fork point to static files (backend/app/golden.py has the format).

Pick the fork frame and click points yourself (open the frame in any image viewer and note the
pixel coordinates of each object), then:

    cd backend
    uv run python scripts/export_golden.py --clip-id street_01 --title "Street, morning" \\
        --video ~/clips/street.mp4 --t 3.2 --click 450,420 --click 920,520

    # or from a still frame (PNG/JPEG), e.g. when OpenCV can't decode the phone's HEVC:
    uv run python scripts/export_golden.py --clip-id street_01 --image frame.png --click 450,420

Uses the same adapters as the server: free fakes unless SCENEFORK_ADAPTERS=live. Live runs go through
the SpendLedger and dev cache (a re-export of the same frame and clicks is free) and ask before
spending. Each object costs about $0.014 live (SAM click + grounding + one Muse Image edit).
"""

import argparse
import asyncio
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import golden, vision  # noqa: E402
from app.adapters import build_adapters  # noqa: E402
from app.config import REPO_DIR, load_settings  # noqa: E402
from app.devcache import DevCache  # noqa: E402
from app.spend import IMAGE_PER_EDIT, SAM_PER_IMAGE, SpendLedger  # noqa: E402

PER_OBJECT_USD = SAM_PER_IMAGE + IMAGE_PER_EDIT + 0.002
DEFAULT_OUT = REPO_DIR / "frontend" / "public" / "golden"


def parse_click(s: str) -> list[tuple[int, int]]:
    """"x,y" or several points on one object: "x,y+x2,y2"."""
    points = []
    for part in s.split("+"):
        x, y = part.split(",")
        points.append((int(float(x)), int(float(y))))
    return points


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--clip-id", required=True, help="lowercase letters, digits and _")
    ap.add_argument("--title", default="")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--video", type=Path)
    src.add_argument("--image", type=Path)
    ap.add_argument("--t", type=float, default=0.0, help="fork time in seconds (with --video)")
    ap.add_argument("--fork-index", type=int, default=0)
    ap.add_argument("--click", action="append", type=parse_click, required=True, help="x,y in frame pixels (after fitting to 1280); x,y+x2,y2 for several points on one object. List stacked objects top first.")
    ap.add_argument("--ppm", type=float, help="pixels per meter; default: derived from grounding (OV6)")
    ap.add_argument("--floor-y", type=float, help="where thrown objects land, in frame pixels (e.g. a table surface); default: the frame's bottom edge")
    ap.add_argument("--copy-video", action="store_true", help="copy the video next to the manifest so the player can play it")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--yes", action="store_true", help="don't ask before live spending")
    args = ap.parse_args()

    settings = load_settings()
    frame = golden.fit_frame(golden.video_frame(args.video, args.t) if args.video else vision.decode_image(args.image.read_bytes()))
    h, w = frame.shape[:2]
    for x, y in [p for click in args.click for p in click]:
        if not (0 <= x < w and 0 <= y < h):
            print(f"click ({x}, {y}) is outside the {w}x{h} frame", file=sys.stderr)
            return 2

    live = settings.adapters == "live"
    if live:
        estimate = len(args.click) * PER_OBJECT_USD
        print(f"Live models: {len(args.click)} objects, up to ${estimate:.3f} (cached requests are free).")
        if not args.yes and input("Spend it? [y/N] ").strip().lower() != "y":
            return 1
    ledger = SpendLedger(settings.spend_dir, settings.spend_cap_usd)
    before = ledger.total_usd
    adapters = build_adapters(settings, ledger, DevCache(settings.cache_dir, settings.dev_cache))

    print(f"Exporting {args.clip_id}/{args.fork_index} ({w}x{h}, {'live' if live else 'fake'} models)")
    objects, skipped = asyncio.run(golden.export_fork(adapters, frame, args.click))
    for s in skipped:
        print(f"  skipped: {s}")
    video_rel = None
    if args.video and args.copy_video:
        dest = args.out / args.clip_id / f"clip{args.video.suffix.lower()}"
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(args.video, dest)
        video_rel = f"{args.clip_id}/{dest.name}"
    manifest = golden.write_fork(args.out, args.clip_id, args.title or args.clip_id, args.fork_index, args.t, frame, objects, args.ppm, video_rel, args.floor_y)
    print(f"Wrote {len(objects)} objects, {manifest['pixels_per_meter']} px/m, to {args.out / args.clip_id / str(args.fork_index)}")
    print(f"Spent ${ledger.total_usd - before:.4f} (ledger total ${ledger.total_usd:.4f})")
    return 0 if objects else 1


if __name__ == "__main__":
    raise SystemExit(main())
