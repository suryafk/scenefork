"""Probe Muse Voice Transcribe realtime (push-to-talk), the path the app uses.

Speaks a few commands with macOS `say`, streams them as 16 kHz PCM at real-time pace (like a mic),
and reports partials, the final transcript and the latency from key-up (endStream) to final.

    cd backend && uv run python scripts/probe_voice.py

Costs about $0.0002 per run ($0.18 per audio hour).
"""

import asyncio
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import load_settings  # noqa: E402
from app.spend import VOICE_PER_SECOND, SpendLedger  # noqa: E402
from app.voice import BYTES_PER_SECOND, LiveTranscriber, keywords_for  # noqa: E402

COMMANDS = ["moon gravity", "slingshot the cactus", "make this bouncy", "spin the stapler when it hits the mug"]
FRAME_MS = 80


def speak(text: str) -> bytes:
    with tempfile.TemporaryDirectory() as td:
        aiff, raw = Path(td) / "s.aiff", Path(td) / "s.raw"
        subprocess.run(["say", "-o", str(aiff), text], check=True)
        subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", str(aiff), str(raw)], check=True)
        return raw.read_bytes()[44:]  # strip the WAV header: raw s16le mono


async def one(transcriber: LiveTranscriber, text: str, keywords: list[str]) -> dict:
    pcm = speak(text)
    t_open = time.perf_counter()
    stream = await transcriber.open(keywords)
    opened_ms = (time.perf_counter() - t_open) * 1000
    partials: list[tuple[float, str]] = []
    final: dict = {}
    t0 = time.perf_counter()

    async def read():
        async for ev in stream.events():
            if ev.get("type") == "transcript":
                partials.append((round((time.perf_counter() - t0) * 1000), ev["transcript"]))
                if ev.get("final"):
                    final["text"] = ev["transcript"]
                    final["at"] = time.perf_counter()

    reader = asyncio.create_task(read())
    step = BYTES_PER_SECOND * FRAME_MS // 1000
    for i in range(0, len(pcm), step):
        await stream.send_audio(pcm[i : i + step])
        await asyncio.sleep(FRAME_MS / 1000)  # real-time pace, like a mic
    t_end = time.perf_counter()
    await stream.end()
    await asyncio.wait_for(reader, 20)
    await stream.close()
    return {
        "said": text,
        "heard": final.get("text"),
        "audio_s": round(len(pcm) / BYTES_PER_SECOND, 2),
        "connect_ms": round(opened_ms),
        "release_to_final_ms": round((final["at"] - t_end) * 1000) if "at" in final else None,
        "first_partial_ms": partials[0][0] if partials else None,
        "partials": len(partials),
    }


async def main() -> None:
    s = load_settings()
    transcriber = LiveTranscriber(s.model_api_key, s.model_api_base)
    ledger = SpendLedger(s.spend_dir, s.spend_cap_usd)
    keywords = keywords_for(["small potted cactus", "desk stapler", "blue ceramic mug", "smartphone"], ["slingshot", "bouncy", "gravity", "moon", "spin"])
    seconds = 0.0
    for text in COMMANDS:
        r = await one(transcriber, text, keywords)
        seconds += r["audio_s"]
        print(r)
    ledger.charge("muse-voice-transcribe-1.0", seconds * VOICE_PER_SECOND, seconds=round(seconds, 2), purpose="probe")
    print(f"audio {seconds:.1f} s, about ${seconds * VOICE_PER_SECOND:.5f}")


if __name__ == "__main__":
    asyncio.run(main())
