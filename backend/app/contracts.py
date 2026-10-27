"""The shared/ contracts (eng review D8): one copy of each schema and table, read by both stacks."""

import json
import re
from functools import lru_cache

from jsonschema import Draft202012Validator

from .config import SHARED_DIR


@lru_cache
def schema(name: str) -> dict:
    return json.loads((SHARED_DIR / f"{name}.schema.json").read_text())


@lru_cache
def validator(name: str) -> Draft202012Validator:
    return Draft202012Validator(schema(name))


def is_valid(name: str, doc) -> bool:
    return validator(name).is_valid(doc)


@lru_cache
def label_defaults() -> dict:
    return json.loads((SHARED_DIR / "label_defaults.json").read_text())


def defaults_for(label: str | None) -> dict:
    """Physics for a label by keyword match, else the default. Shared with the frontend."""
    table = label_defaults()
    if label:
        words = re.findall(r"[a-z]+", label.lower())
        for word in words:
            if word in table["keywords"]:
                return dict(table["keywords"][word])
    return dict(table["default"])


#: Keywords enforced locally (clamp or validate after decoding), not sent in response_format.
MODEL_SCHEMA_DROP = {"$schema", "$id", "title", "description", "minimum", "maximum", "minLength", "maxLength",
                     "exclusiveMinimum", "pattern", "minItems", "maxItems"}


def model_schema(name: str) -> dict:
    """The schema as sent in response_format: structure only (types, enums, required).

    Range keywords are enforced locally by clamping, so a model API that rejects them in
    strict mode still works.
    """

    def strip(node):
        if isinstance(node, dict):
            return {
                k: strip(v)
                for k, v in node.items()
                if k not in MODEL_SCHEMA_DROP
            }
        if isinstance(node, list):
            return [strip(v) for v in node]
        return node

    return strip(schema(name))


def clamp_to_schema(name: str, doc: dict) -> dict:
    """Clamp numeric fields into their schema ranges and trim strings."""
    props = schema(name)["properties"]
    out = dict(doc)
    for key, spec in props.items():
        if key not in out:
            continue
        if spec.get("type") == "number" and isinstance(out[key], (int, float)):
            lo = spec.get("minimum", float("-inf"))
            hi = spec.get("maximum", float("inf"))
            out[key] = min(max(float(out[key]), lo), hi)
        if spec.get("type") == "string" and isinstance(out[key], str) and "maxLength" in spec:
            out[key] = out[key][: spec["maxLength"]]
    return out


#: Labels that mean the click hit scenery, not an object (Phase 2 live test: a road strip came back
#: as "delivery truck" only because the outline was huge; when the label is scenery, pin it).
BACKGROUND_WORDS = {"road", "street", "sidewalk", "pavement", "asphalt", "ground", "floor", "sky", "wall", "building",
                    "grass", "lawn", "field", "ceiling", "background", "curb", "lane", "highway", "terrain"}


def pin_background(grounding: dict) -> dict:
    """Force body_type fixed when the label names scenery, so it can't be thrown around."""
    words = set(re.findall(r"[a-z]+", grounding.get("label", "").lower()))
    if words & BACKGROUND_WORDS:
        return {**grounding, "body_type": "fixed"}
    return grounding
