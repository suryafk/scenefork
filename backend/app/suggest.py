"""Rule suggestions per scene: Muse Spark looks at the freed objects and offers a few things to say.

Shown as tappable chips, they solve the blank-prompt problem (most people don't know what to ask a
physics sandbox for). A chip runs exactly like a spoken command, so a suggestion still goes through
the preset router or the generate → verify → repair loop. Text only (labels, masses), no image:
about $0.002 per new set of objects, and the dev cache makes re-forking the same scene free.
"""

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Protocol

from jsonschema import Draft202012Validator

from . import contracts
from .config import SHARED_DIR
from .devcache import DevCache, request_key
from .metaapi import MetaModelAPI
from .spend import SPARK_RESERVE, SpendLedger, spark_cost

MODEL = "muse-spark-1.3"
MAX_ENTITIES = 40
MAX_SUGGESTIONS = 4
MAX_TEXT = 60


@dataclass
class SuggestResult:
    suggestions: list[dict]
    cached: bool = False


class Suggester(Protocol):
    async def suggest(self, entities: list[dict]) -> SuggestResult: ...


@lru_cache
def preset_phrases() -> list[str]:
    presets = json.loads((SHARED_DIR / "presets.json").read_text())["presets"]
    return [p["name"].lower() for p in presets if p.get("action") != "reset"]


def scene_entities(raw) -> list[dict]:
    """The client's scene summary, reduced to what the prompt needs (and bounded)."""
    out = []
    for e in raw[:MAX_ENTITIES] if isinstance(raw, list) else []:
        if not isinstance(e, dict) or not isinstance(e.get("label"), str):
            continue
        out.append({"label": e["label"].replace("_", " ")[:40], "dynamic": bool(e.get("dynamic", True)), "mass_kg": round(float(e.get("mass_kg") or 0), 2)})
    return out


def clean(doc: dict) -> list[dict]:
    """Keep well-formed, distinct suggestions, at most four."""
    seen, out = set(), []
    for s in doc.get("suggestions", []) if isinstance(doc, dict) else []:
        if not isinstance(s, dict) or s.get("kind") not in ("preset", "rule") or not isinstance(s.get("text"), str):
            continue
        text = re.sub(r"\s+", " ", s["text"]).strip().rstrip(".!")[:MAX_TEXT]
        if len(text) >= 3 and text.lower() not in seen:
            seen.add(text.lower())
            out.append({"text": text, "kind": s["kind"]})
    return out[:MAX_SUGGESTIONS]


SYSTEM_PROMPT = """You suggest playful physics rules for SceneFork, a 2D physics sandbox made from a paused video. The user has pulled these objects out of the frame and can throw them around. Suggest exactly 4 short things the user could say (at most 8 words each) that would look fun on screen.

- 1 suggestion is a world-wide preset, with kind "preset", worded exactly as one of: {presets}.
- 3 suggestions are creative rules, with kind "rule", each about specific objects from the list, named by a word from their label (e.g. "slingshot the cactus", "make the mug bounce like rubber", "when the phone hits the books, launch it up").
- Rules can only change gravity, time speed, an object's mass, bounciness, friction or damping, pin an object in place, push, launch or spin objects, and react when an object is grabbed, released, or hits something.
- Nothing about colors, sounds, text, new objects, explosions into pieces, or the camera.
- Vary them: not all the same verb, and prefer surprising combinations of the objects listed."""


def build_messages(entities: list[dict]) -> list[dict]:
    return [
        {"role": "system", "content": SYSTEM_PROMPT.format(presets=", ".join(preset_phrases()))},
        {"role": "user", "content": f"Objects: {json.dumps(entities, separators=(',', ':'))}"},
    ]


# ---------------------------------------------------------------- fake (free)


def _word(label: str) -> str:
    """The word a command would use for an object: the label's last word, its noun ("blue ceramic mug" → mug)."""
    words = [w for w in re.findall(r"[a-z]+", label.lower()) if len(w) >= 3]
    return (words or ["object"])[-1]


class FakeSuggester:
    """Templates using the commands the fake MutatorAgent knows, so chips work offline and in E2E."""

    async def suggest(self, entities: list[dict]) -> SuggestResult:
        movable = sorted((e for e in entities if e["dynamic"]), key=lambda e: e["mass_kg"])
        if not movable:
            return SuggestResult([{"text": "zero gravity", "kind": "preset"}])
        light, heavy = _word(movable[0]["label"]), _word(movable[-1]["label"])
        middle = _word(movable[len(movable) // 2]["label"])
        out = [
            {"text": "zero gravity", "kind": "preset"},
            {"text": f"slingshot the {heavy}", "kind": "rule"},
            {"text": f"spin the {middle}", "kind": "rule"},
            {"text": f"make the {light} heavy", "kind": "rule"},
        ]
        return SuggestResult(clean({"suggestions": out}))


# ---------------------------------------------------------------- live (costs credits)


class LiveSuggester:
    """muse-spark-1.3, Standard mode, reasoning_effort=minimal; json_schema-constrained output."""

    def __init__(self, api: MetaModelAPI, ledger: SpendLedger, cache: DevCache, effort: str) -> None:
        self.api, self.ledger, self.cache, self.effort = api, ledger, cache, effort

    async def suggest(self, entities: list[dict]) -> SuggestResult:
        messages = build_messages(entities)
        key = request_key(MODEL, self.effort, "suggest-v1", json.dumps(messages, sort_keys=True))
        doc = self.cache.get_json(key)
        cached = doc is not None
        if doc is None:
            self.ledger.check(SPARK_RESERVE)
            doc, usage = await self.api.spark_messages_json(MODEL, self.effort, messages, contracts.model_schema("suggestions"), "RuleSuggestions")
            self.ledger.charge(MODEL, spark_cost(usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0)), purpose="suggest")
            self.cache.put_json(key, doc)
        return SuggestResult(clean(doc), cached)


def is_valid(suggestions: list[dict]) -> bool:
    return Draft202012Validator(contracts.schema("suggestions")).is_valid({"suggestions": suggestions})
