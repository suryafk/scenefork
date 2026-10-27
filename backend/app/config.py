"""Runtime settings, read once from the environment (and backend/.env for local dev)."""

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent
SHARED_DIR = Path(os.environ.get("SCENEFORK_SHARED_DIR", REPO_DIR / "shared"))


def _load_dotenv() -> None:
    env = BACKEND_DIR / ".env"
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"'))


@dataclass(frozen=True)
class Settings:
    #: "fake" (default: free, local OpenCV stand-ins) or "live" (Meta Model API, costs credits).
    adapters: str = "fake"
    model_api_key: str = ""
    model_api_base: str = "https://api.meta.ai/v1"
    #: Hard cap for live calls, checked before every call (CLAUDE.md credit budget).
    spend_cap_usd: float = 10.0
    spend_dir: Path = BACKEND_DIR / ".spend"
    #: Replay identical live requests from disk instead of paying again.
    dev_cache: bool = True
    cache_dir: Path = BACKEND_DIR / ".cache"
    #: Shared demo key (eng review D5). Empty means auth is off (local dev only).
    demo_token: str = ""
    asset_secret: bytes = field(default_factory=lambda: secrets.token_bytes(32))
    allowed_origins: tuple[str, ...] = ("http://localhost:5173", "http://127.0.0.1:5173")
    fork_ttl_s: float = 30 * 60
    grounding_effort: str = "minimal"


def load_settings() -> Settings:
    _load_dotenv()
    origins = os.environ.get("SCENEFORK_ALLOWED_ORIGINS")
    token = os.environ.get("SCENEFORK_DEMO_TOKEN", "")
    return Settings(
        adapters=os.environ.get("SCENEFORK_ADAPTERS", "fake"),
        model_api_key=os.environ.get("MODEL_API_KEY", ""),
        spend_cap_usd=float(os.environ.get("SPEND_CAP_USD", "10")),
        dev_cache=os.environ.get("SCENEFORK_DEV_CACHE", "1") == "1",
        demo_token=token,
        # Stable across restarts when a demo token exists, so signed asset URLs survive a reload.
        asset_secret=(token.encode() + b"|assets") if token else secrets.token_bytes(32),
        allowed_origins=tuple(o.strip() for o in origins.split(",")) if origins else Settings.allowed_origins,
    )
