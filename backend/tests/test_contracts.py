"""Contract test (eng review D8): the backend accepts and rejects the same shared fixtures the frontend does."""

import json

import pytest

from app import contracts
from app.config import SHARED_DIR

FIX = SHARED_DIR / "fixtures"


@pytest.mark.parametrize("name", ["grounding", "entity"])
def test_shared_fixtures(name):
    for doc in json.loads((FIX / f"{name}_valid.json").read_text()):
        assert contracts.is_valid(name, doc), doc
    for doc in json.loads((FIX / f"{name}_invalid.json").read_text()):
        assert not contracts.is_valid(name, doc), doc


def test_defaults_match_label_keywords():
    assert contracts.defaults_for("Red delivery TRUCK")["acoustic_material"] == "hollow_metal"
    assert contracts.defaults_for("coffee mug")["mass_kg"] == pytest.approx(0.35)
    assert contracts.defaults_for("mysterious blob") == contracts.label_defaults()["default"]
    assert contracts.defaults_for(None) == contracts.label_defaults()["default"]


def test_model_schema_keeps_structure_and_drops_ranges():
    s = contracts.model_schema("grounding")
    assert "$schema" not in s and "minimum" not in json.dumps(s)
    assert s["required"] == contracts.schema("grounding")["required"]
    assert s["additionalProperties"] is False
    assert "enum" in s["properties"]["acoustic_material"]


def test_clamp_brings_model_output_into_range():
    raw = {"label": "x" * 100, "body_type": "dynamic", "mass_kg": 90000, "restitution": 1.4, "friction": -2,
           "acoustic_material": "wood", "approx_height_m": 0}
    fixed = contracts.clamp_to_schema("grounding", raw)
    assert fixed["mass_kg"] == 5000 and fixed["restitution"] == 0.95 and fixed["friction"] == 0
    assert len(fixed["label"]) == 60
    assert contracts.is_valid("grounding", fixed)


@pytest.mark.parametrize(
    "label,pinned",
    [("asphalt road", True), ("sidewalk", True), ("brick wall", True), ("red delivery truck", False),
     ("water bottle", False), ("traffic cone", False)],
)
def test_scenery_labels_are_pinned_fixed(label, pinned):
    g = {"label": label, "body_type": "dynamic", "mass_kg": 1, "restitution": 0.1, "friction": 0.5,
         "acoustic_material": "concrete", "approx_height_m": 1}
    assert (contracts.pin_background(g)["body_type"] == "fixed") is pinned
