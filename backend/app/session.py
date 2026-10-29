"""In-memory fork state with a TTL (Retention: no disk writes for user frames).

The Modal app runs with max_containers=1, so one process holds every live fork. A golden
clip never reaches here (OV1: golden clips are static and client-side).
"""

import asyncio
import hmac
import secrets
import time
from dataclasses import dataclass, field
from hashlib import sha256

import numpy as np


@dataclass
class Fork:
    id: str
    frame: np.ndarray
    frame_jpeg: bytes
    plate: np.ndarray
    plate_version: int = 0
    next_object: int = 1
    #: Masks of freed objects whose inpaint hasn't landed: the plate still shows them (10-20 s
    #: live), so without this a second click on one would free a duplicate.
    unpainted: dict[str, np.ndarray] = field(default_factory=dict)
    assets: dict[str, tuple[bytes, str]] = field(default_factory=dict)
    #: Inpaints run one at a time per fork, each on the current plate (design step 6).
    inpaint_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    created: float = field(default_factory=time.monotonic)
    last_used: float = field(default_factory=time.monotonic)

    @property
    def taken(self) -> np.ndarray | None:
        """Pixels of objects already freed but still on the plate."""
        return np.logical_or.reduce(list(self.unpainted.values())) if self.unpainted else None

    @property
    def size(self) -> tuple[int, int]:
        h, w = self.frame.shape[:2]
        return w, h


class SessionStore:
    def __init__(self, ttl_s: float) -> None:
        self.ttl_s = ttl_s
        self._forks: dict[str, Fork] = {}

    def create(self, frame: np.ndarray, frame_jpeg: bytes) -> Fork:
        self.purge()
        fork = Fork(id="f_" + secrets.token_hex(8), frame=frame, frame_jpeg=frame_jpeg, plate=frame.copy())
        self._forks[fork.id] = fork
        return fork

    def get(self, fork_id: str) -> Fork | None:
        fork = self._forks.get(fork_id)
        if fork is None:
            return None
        now = time.monotonic()
        if now - fork.last_used > self.ttl_s:
            del self._forks[fork_id]
            return None
        fork.last_used = now
        return fork

    def purge(self) -> None:
        now = time.monotonic()
        for fid in [f.id for f in self._forks.values() if now - f.last_used > self.ttl_s]:
            del self._forks[fid]

    def __len__(self) -> int:
        return len(self._forks)


class AssetSigner:
    """HMAC signature binding an asset URL to its fork and asset id (eng review D5)."""

    def __init__(self, secret: bytes) -> None:
        self._secret = secret

    def sign(self, fork_id: str, asset_id: str) -> str:
        return hmac.new(self._secret, f"{fork_id}/{asset_id}".encode(), sha256).hexdigest()[:32]

    def verify(self, fork_id: str, asset_id: str, sig: str) -> bool:
        return hmac.compare_digest(self.sign(fork_id, asset_id), sig or "")

    def url(self, fork_id: str, asset_id: str) -> str:
        return f"/asset/{fork_id}/{asset_id}?sig={self.sign(fork_id, asset_id)}"
