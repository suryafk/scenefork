"""Dev response cache: identical live requests replay from disk for free.

Keyed by a sha256 of the request (endpoint, model, prompt, media bytes). Only used in
development; judge or user frames never reach it when it's off (SCENEFORK_DEV_CACHE=0).
"""

import hashlib
import json
from pathlib import Path


def request_key(*parts: bytes | str) -> str:
    h = hashlib.sha256()
    for p in parts:
        b = p.encode() if isinstance(p, str) else p
        h.update(len(b).to_bytes(8, "big"))
        h.update(b)
    return h.hexdigest()


class DevCache:
    def __init__(self, directory: Path, enabled: bool) -> None:
        self.dir = directory
        self.enabled = enabled
        self.hits = 0
        if enabled:
            directory.mkdir(parents=True, exist_ok=True)

    def get(self, key: str) -> bytes | None:
        if not self.enabled:
            return None
        path = self.dir / key
        if path.exists():
            self.hits += 1
            return path.read_bytes()
        return None

    def put(self, key: str, value: bytes) -> None:
        if self.enabled:
            (self.dir / key).write_bytes(value)

    def get_json(self, key: str):
        raw = self.get(key)
        return json.loads(raw) if raw is not None else None

    def put_json(self, key: str, value) -> None:
        self.put(key, json.dumps(value).encode())
