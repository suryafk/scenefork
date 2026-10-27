"""SpendLedger: every live Model API call is estimated, checked against the cap, then logged.

The project has $150 of credit for the whole build (CLAUDE.md). Prices come from
docs/model-probe.md; the ledger is an estimate, the Model API dashboard is the truth.
"""

import json
import threading
import time
from dataclasses import dataclass
from pathlib import Path

# USD, from dev.meta.ai pricing (2026-10-27).
SAM_PER_IMAGE = 2.50 / 1000
IMAGE_PER_EDIT = 0.01
SPARK_IN_PER_TOKEN = 1.25 / 1_000_000
SPARK_OUT_PER_TOKEN = 4.25 / 1_000_000
VOICE_PER_SECOND = 0.18 / 3600
#: Pre-call reservation for a Spark call whose token count isn't known yet.
SPARK_RESERVE = 0.01


class SpendCapExceeded(RuntimeError):
    pass


def spark_cost(prompt_tokens: int, completion_tokens: int) -> float:
    return prompt_tokens * SPARK_IN_PER_TOKEN + completion_tokens * SPARK_OUT_PER_TOKEN


@dataclass
class Charge:
    kind: str
    usd: float
    meta: dict


class SpendLedger:
    def __init__(self, directory: Path, cap_usd: float) -> None:
        self.cap_usd = cap_usd
        self.path = directory / "ledger.jsonl"
        directory.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._total = 0.0
        if self.path.exists():
            for line in self.path.read_text().splitlines():
                if line.strip():
                    self._total += json.loads(line)["usd"]

    @property
    def total_usd(self) -> float:
        return self._total

    def check(self, estimate_usd: float) -> None:
        """Refuse a call that would push spend past the cap."""
        if self._total + estimate_usd > self.cap_usd:
            raise SpendCapExceeded(
                f"spend cap reached: ${self._total:.4f} spent, ${estimate_usd:.4f} more would exceed ${self.cap_usd:.2f}"
            )

    def charge(self, kind: str, usd: float, **meta) -> Charge:
        with self._lock:
            self._total += usd
            with self.path.open("a") as f:
                f.write(json.dumps({"ts": time.time(), "kind": kind, "usd": round(usd, 6), **meta}) + "\n")
        return Charge(kind, usd, meta)
