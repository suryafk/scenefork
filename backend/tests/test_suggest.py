"""Rule suggestions: prompt, fake templates, cleanup, live adapter against a stub (zero credits)."""

import asyncio
import json

from app.devcache import DevCache
from app.spend import SpendLedger
from app.suggest import FakeSuggester, LiveSuggester, build_messages, clean, is_valid, preset_phrases, scene_entities
from tests.test_ws import ORIGIN, client, recv_until

DESK = [
    {"id": "obj_1", "label": "small potted cactus", "dynamic": True, "mass_kg": 0.4},
    {"id": "obj_2", "label": "blue_ceramic_mug", "dynamic": True, "mass_kg": 0.35},
    {"id": "obj_3", "label": "desk stapler", "dynamic": True, "mass_kg": 0.25},
    {"id": "obj_4", "label": "street lamp post", "dynamic": False, "mass_kg": 80},
]


def run(coro):
    return asyncio.run(coro)


def test_prompt_lists_presets_and_the_objects():
    msgs = build_messages(scene_entities(DESK))
    assert "zero gravity" in msgs[0]["content"] and "mars gravity" in msgs[0]["content"]
    assert "reset" not in preset_phrases()
    assert '"label":"blue ceramic mug"' in msgs[1]["content"]  # underscores become spaces


def test_fake_suggestions_use_commands_the_fake_mutator_knows():
    out = run(FakeSuggester().suggest(scene_entities(DESK))).suggestions
    # Movable by mass: stapler 0.25 < mug 0.35 < cactus 0.4 (the lamp post is fixed).
    assert [s["text"] for s in out] == ["zero gravity", "slingshot the cactus", "spin the mug", "make the stapler heavy"]
    assert out[0] == {"text": "zero gravity", "kind": "preset"}
    assert all(s["text"].split()[0] in ("zero", "slingshot", "spin", "make") for s in out)
    assert is_valid(out)


def test_clean_drops_bad_items_and_duplicates():
    doc = {"suggestions": [
        {"text": "Zero gravity!", "kind": "preset"}, {"text": "zero gravity", "kind": "preset"},
        {"text": "x", "kind": "rule"}, {"text": "spin the mug", "kind": "wish"},
        {"text": "slingshot   the cactus.", "kind": "rule"}, {"text": "a" * 80, "kind": "rule"}, {"text": "make the mug heavy", "kind": "rule"},
    ]}
    assert clean(doc) == [
        {"text": "Zero gravity", "kind": "preset"},
        {"text": "slingshot the cactus", "kind": "rule"},
        {"text": "a" * 60, "kind": "rule"},
        {"text": "make the mug heavy", "kind": "rule"},
    ]


class StubAPI:
    def __init__(self, doc):
        self.doc, self.calls = doc, 0

    async def spark_messages_json(self, model, effort, messages, schema, name):
        self.calls += 1
        assert (model, effort, name) == ("muse-spark-1.3", "minimal", "RuleSuggestions")
        return dict(self.doc), {"prompt_tokens": 600, "completion_tokens": 90}


def test_live_suggester_charges_once_per_scene_then_replays(tmp_path):
    api = StubAPI({"suggestions": [{"text": "mars gravity", "kind": "preset"}, {"text": "slingshot the cactus", "kind": "rule"}]})
    ledger = SpendLedger(tmp_path / "s", 1.0)
    s = LiveSuggester(api, ledger, DevCache(tmp_path / "c", True), "minimal")
    first = run(s.suggest(scene_entities(DESK)))
    assert [x["text"] for x in first.suggestions] == ["mars gravity", "slingshot the cactus"] and not first.cached
    assert 0 < ledger.total_usd < 0.002
    assert run(s.suggest(scene_entities(DESK))).cached and api.calls == 1


def test_suggest_over_the_websocket(settings):
    with client(settings).websocket_connect("/ws", headers=ORIGIN) as ws:
        ws.receive_json()
        ws.send_json({"type": "suggest", "req_id": "s1", "entities": DESK})
        msg, _ = recv_until(ws, "suggestions")
        assert msg["req_id"] == "s1" and len(msg["suggestions"]) == 4 and is_valid(msg["suggestions"])
        ws.send_json({"type": "suggest", "req_id": "s2", "entities": "nonsense"})
        msg, _ = recv_until(ws, "suggestions")
        assert msg["suggestions"] == []
    assert json.dumps(DESK)  # unchanged input
