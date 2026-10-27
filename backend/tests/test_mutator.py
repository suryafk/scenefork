"""MutatorAgent: prompt, fake templates, and the live adapter against a stubbed API (zero credits)."""

import asyncio
import json

import pytest

from app import contracts
from app.config import SHARED_DIR
from app.devcache import DevCache
from app.mutator import CodegenRequest, FakeMutator, LiveMutator, build_messages, schema_problems
from app.spend import SpendCapExceeded, SpendLedger

SCENE = {
    "bounds_m": {"width": 12.8, "height": 7.2},
    "gravity": [0, 9.81],
    "entities": [
        {"id": "truck", "label": "red_delivery_truck", "dynamic": True, "x": 3.2, "y": 4.6, "width": 3.2, "height": 1.8, "mass_kg": 3500},
        {"id": "lamp", "label": "street_lamp_post", "dynamic": False, "x": 10.5, "y": 3.0, "width": 0.2, "height": 4.0, "mass_kg": 80},
    ],
}
SLINGSHOT = json.loads((SHARED_DIR / "fixtures" / "plugin_valid.json").read_text())[0]


def req(text, attempt=0, previous=None, bindings=None):
    return CodegenRequest(text, SCENE, bindings or {"thisId": "truck", "thatId": None, "named": []}, attempt, previous)


def run(coro):
    return asyncio.run(coro)


def test_model_schema_for_plugin_keeps_structure_for_strict_decoding():
    s = contracts.model_schema("plugin")
    text = json.dumps(s)
    assert "pattern" not in text and "maxItems" not in text and "minimum" not in text
    assert s["required"] == contracts.schema("plugin")["required"]
    item = s["properties"]["assertions"]["items"]
    assert item["additionalProperties"] is False and "enum" in item["properties"]["cmp"]


def test_prompt_embeds_ctx_api_verbatim_and_repairs_carry_the_error():
    msgs = build_messages(req("slingshot this truck"))
    assert (SHARED_DIR / "ctx.d.ts").read_text() in msgs[0]["content"]
    assert '"thisId":"truck"' in msgs[1]["content"] and "slingshot this truck" in msgs[1]["content"]
    repair = build_messages(req("slingshot this truck", 1, {"plugin": SLINGSHOT, "error": "assertion 1: vx was 0.1"}))
    assert "assertion 1: vx was 0.1" in repair[1]["content"] and "failed verification" in repair[1]["content"]


@pytest.mark.parametrize("text", ["slingshot this truck", "spin it", "sideways gravity", "make it heavy"])
def test_fake_templates_are_valid_plugins(text):
    result = run(FakeMutator().generate(req(text)))
    assert result.problems == [] and result.plugin["feasible"]
    assert all(w.startswith(("entity:truck.", "world.")) for w in result.plugin["writes"])


def test_fake_says_no_gracefully():
    result = run(FakeMutator().generate(req("paint the sky purple")))
    assert result.plugin["feasible"] is False and result.problems == []


def test_schema_problems_name_the_bad_field():
    bad = {**SLINGSHOT, "writes": ["world.colour"]}
    problems = schema_problems(bad)
    assert len(problems) == 1 and problems[0].startswith("writes/0:")


class StubAPI:
    def __init__(self, doc):
        self.doc, self.calls = doc, []

    async def spark_messages_json(self, model, effort, messages, schema, name):
        self.calls.append((model, effort, name))
        return dict(self.doc), {"prompt_tokens": 3000, "completion_tokens": 700}


def test_live_mutator_charges_once_then_replays_from_the_dev_cache(tmp_path):
    api = StubAPI(SLINGSHOT)
    ledger = SpendLedger(tmp_path / "s", 1.0)
    m = LiveMutator(api, ledger, DevCache(tmp_path / "c", True), "minimal")
    first = run(m.generate(req("slingshot this truck")))
    assert first.problems == [] and not first.cached
    assert api.calls == [("muse-spark-1.3", "minimal", "MutatorPlugin")]
    assert 0.005 < ledger.total_usd < 0.01  # 3000 in + 700 out at Spark prices
    again = run(m.generate(req("slingshot this truck")))
    assert again.cached and len(api.calls) == 1


def test_live_mutator_refuses_before_calling_past_the_cap(tmp_path):
    api = StubAPI(SLINGSHOT)
    m = LiveMutator(api, SpendLedger(tmp_path / "s", 0.01), DevCache(tmp_path / "c", False), "minimal")
    with pytest.raises(SpendCapExceeded):
        run(m.generate(req("slingshot this truck")))
    assert api.calls == []


def test_live_mutator_reports_schema_problems_for_the_repair_round(tmp_path):
    api = StubAPI({**SLINGSHOT, "assertions": [{**SLINGSHOT["assertions"][0], "at_tick": 999}]})
    m = LiveMutator(api, SpendLedger(tmp_path / "s", 1.0), DevCache(tmp_path / "c", False), "minimal")
    assert run(m.generate(req("slingshot"))).problems[0].startswith("assertions/0/at_tick")
