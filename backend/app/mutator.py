"""MutatorAgent (design: Mutator contract): one voice command → a sandboxed plugin, the fields it
writes and the assertions the browser's verifier checks.

The browser drives the loop (generate, verify in a shadow worker, repair up to 2 times), so each
call here is stateless: a repair request carries the previous plugin and the verifier's error.
`shared/ctx.d.ts` goes into the prompt verbatim, so the model, the runtime and the verifier share
one API definition.
"""

import json
from dataclasses import dataclass
from typing import Protocol

from jsonschema import Draft202012Validator

from . import contracts
from .config import SHARED_DIR
from .devcache import DevCache, request_key
from .metaapi import MetaModelAPI
from .spend import CODEGEN_RESERVE, SpendLedger, spark_cost

MAX_ATTEMPT = 2
MAX_COMMAND_CHARS = 300
MODEL = "muse-spark-1.3"


@dataclass
class CodegenRequest:
    text: str
    scene: dict
    bindings: dict
    attempt: int
    previous: dict | None  # {"plugin": {...}, "error": "..."}


@dataclass
class CodegenResult:
    plugin: dict
    #: Schema violations, sent back so the browser turns them into a repair round.
    problems: list[str]
    cached: bool = False


class Mutator(Protocol):
    async def generate(self, req: CodegenRequest) -> CodegenResult: ...


def ctx_api() -> str:
    return (SHARED_DIR / "ctx.d.ts").read_text()


def schema_problems(doc: dict) -> list[str]:
    validator = Draft202012Validator(contracts.schema("plugin"))
    out = []
    for err in sorted(validator.iter_errors(doc), key=lambda e: list(e.absolute_path))[:5]:
        where = "/".join(str(p) for p in err.absolute_path) or "(root)"
        out.append(f"{where}: {err.message[:160]}")
    return out


SYSTEM_PROMPT = """You write SceneFork physics plugins. SceneFork turns a paused video frame into a 2D rigid-body sandbox. The user speaks a rule; you return one JSON object with a JavaScript plugin for the ctx API below, the fields it writes, and assertions that a verifier runs in a headless copy of the scene.

ctx API (TypeScript declarations; the plugin itself is plain JavaScript):
```ts
{ctx}
```

Rules:
- source is the BODY of function (ctx) {{ ... }}: declare state with let/const at the top, then `return {{ onInit() {{...}}, onStep(dt) {{...}} }}` with only the hooks you need.
- Use entity ids exactly as listed in the scene. The bindings say which entities the command is about: thisId is what the user pointed at, named is what they said by name.
- writes lists every field the plugin changes: "world.gravity", "world.time_scale", or "entity:<id>.<field>" with field mass, restitution, friction, damping, body_type or velocity ("entity:*.<field>" means any entity). velocity covers applyImpulse, setVelocity and setAngularVelocity.
- Impulses are in N*s: to change an entity's speed by dv m/s, apply mass * dv, with mass from ctx.entity(id).mass.
- assertions: 1-4 checks that FAIL without the plugin and PASS with it (the verifier rejects plugins whose assertions also pass without them). Scenario kinds:
  - init: nothing happens; tick 0 is right after onInit.
  - ticks: run n steps (set n, and at_tick <= n).
  - dragRelease: the user drags `entity` by (drag_x_m, drag_y_m) meters over 30 steps, holds still 20 steps, then releases; tick 0 is the release. onGrab and onRelease fire.
  - collision: `entity` is placed just above `other` (an id or "ground") and moves down at rel_speed_mps; onCollision fires on impact.
  Fill unused scenario fields with "" or 0. Target "world" has fields gravity_x, gravity_y, time_scale. Target "entity:<id>" has speed, vx, vy, x, y (meters, +y is down), spin (|angular velocity|, rad/s), restitution, mass, friction, alive (1 or 0). cmp is gt, lt, between (value <= v <= value_max) or changed_by_gt (|v at at_tick - v at tick 0| > value). at_tick is 0-120 (60 ticks = 1 s). Leave margin: use thresholds about half of what the plugin should achieve. Set value_max to 0 unless cmp is between.
- If the command can't be done with ctx (colors, sounds, new objects, the camera), set feasible to false, explain in reason, and leave the other fields empty.
- name is short snake_case; summary is one plain sentence for the user."""


def build_messages(req: CodegenRequest) -> list[dict]:
    user = (
        f"Scene (meters): {json.dumps(req.scene, separators=(',', ':'))}\n"
        f"Bindings: {json.dumps(req.bindings, separators=(',', ':'))}\n"
        f'Command: "{req.text}"'
    )
    if req.previous:
        user += (
            "\n\nYour previous plugin failed verification. Fix it and return the corrected plugin.\n"
            f"Previous plugin: {json.dumps(req.previous.get('plugin'), separators=(',', ':'))}\n"
            f"Verifier error: {str(req.previous.get('error', ''))[:600]}"
        )
    return [{"role": "system", "content": SYSTEM_PROMPT.format(ctx=ctx_api())}, {"role": "user", "content": user}]


# ---------------------------------------------------------------- fake (free)


def _infeasible(reason: str) -> dict:
    return {"feasible": False, "reason": reason, "name": "", "summary": "", "writes": [], "source": "", "assertions": []}


def _scenario(kind: str, entity: str = "", other: str = "", dx: float = 0, dy: float = 0, n: int = 0, rel: float = 0) -> dict:
    return {"kind": kind, "entity": entity, "other": other, "drag_x_m": dx, "drag_y_m": dy, "n": n, "rel_speed_mps": rel}


def _check(scenario: dict, target: str, field: str, cmp: str, value: float, at: int) -> dict:
    return {"scenario": scenario, "target": target, "field": field, "cmp": cmp, "value": value, "value_max": 0, "at_tick": at}


def _target(req: CodegenRequest) -> str | None:
    b = req.bindings or {}
    ids = [e["id"] for e in req.scene.get("entities", []) if e.get("dynamic")]
    for cand in [b.get("thisId"), *(b.get("named") or []), b.get("thatId")]:
        if cand in ids:
            return cand
    return ids[0] if ids else None


class FakeMutator:
    """Deterministic templates for a few demo commands: exercises the whole loop with no credits."""

    async def generate(self, req: CodegenRequest) -> CodegenResult:
        t = req.text.lower()
        target = _target(req)
        if target is None:
            return CodegenResult(_infeasible("there's nothing in the scene to apply it to"), [])
        if "sling" in t or "launch" in t:
            source = (
                f"let start = null;\nconst target = '{target}';\nreturn {{\n"
                "  onGrab(id) { if (id !== target) return; const e = ctx.entity(id); start = { x: e.x, y: e.y }; },\n"
                "  onRelease(id) {\n    if (id !== target || start == null) return;\n    const e = ctx.entity(id);\n"
                "    const k = 12 * e.mass;\n    ctx.applyImpulse(id, (start.x - e.x) * k, (start.y - e.y) * k);\n    start = null;\n  },\n};"
            )
            doc = {
                "feasible": True, "reason": "", "name": f"slingshot_{target}", "summary": f"Pull the {target} back and let go: it flies the other way.",
                "writes": [f"entity:{target}.velocity"], "source": source,
                "assertions": [_check(_scenario("dragRelease", target, dx=-1), f"entity:{target}", "vx", "gt", 3, 3)],
            }
        elif "spin" in t:
            doc = {
                "feasible": True, "reason": "", "name": f"spin_{target}", "summary": f"The {target} spins in place.",
                "writes": [f"entity:{target}.velocity"],
                "source": f"const target = '{target}';\nreturn {{ onStep() {{ ctx.setAngularVelocity(target, 6); }} }};",
                "assertions": [_check(_scenario("ticks", n=30), f"entity:{target}", "spin", "gt", 3, 30)],
            }
        elif "sideways" in t:
            doc = {
                "feasible": True, "reason": "", "name": "sideways_gravity", "summary": "Gravity pulls everything to the right.",
                "writes": ["world.gravity"], "source": "return { onInit() { ctx.setGravity(9.81, 0); } };",
                "assertions": [_check(_scenario("init"), "world", "gravity_x", "gt", 5, 0)],
            }
        elif "heavy" in t:
            doc = {
                "feasible": True, "reason": "", "name": f"heavy_{target}", "summary": f"The {target} weighs ten times more.",
                "writes": [f"entity:{target}.mass"],
                "source": f"const target = '{target}';\nreturn {{ onInit() {{ const e = ctx.entity(target); ctx.setMass(target, e.mass * 10); }} }};",
                "assertions": [_check(_scenario("init"), f"entity:{target}", "mass", "gt", next((e["mass_kg"] for e in req.scene["entities"] if e["id"] == target), 1) * 5, 0)],
            }
        else:
            doc = _infeasible("the offline fake mutator only knows slingshot, spin, sideways gravity and heavy; set SCENEFORK_ADAPTERS=live for Muse Spark")
        return CodegenResult(doc, schema_problems(doc))


# ---------------------------------------------------------------- live (costs credits)


class LiveMutator:
    """muse-spark-1.3, Standard mode, reasoning_effort=minimal; json_schema-constrained output."""

    def __init__(self, api: MetaModelAPI, ledger: SpendLedger, cache: DevCache, effort: str) -> None:
        self.api, self.ledger, self.cache, self.effort = api, ledger, cache, effort

    async def generate(self, req: CodegenRequest) -> CodegenResult:
        messages = build_messages(req)
        key = request_key(MODEL, self.effort, "mutator-v1", json.dumps(messages, sort_keys=True))
        doc = self.cache.get_json(key)
        cached = doc is not None
        if doc is None:
            self.ledger.check(CODEGEN_RESERVE)
            doc, usage = await self.api.spark_messages_json(MODEL, self.effort, messages, contracts.model_schema("plugin"), "MutatorPlugin")
            self.ledger.charge(
                MODEL,
                spark_cost(usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0)),
                purpose="codegen",
                attempt=req.attempt,
                prompt_tokens=usage.get("prompt_tokens", 0),
                completion_tokens=usage.get("completion_tokens", 0),
            )
            self.cache.put_json(key, doc)
        return CodegenResult(doc, schema_problems(doc), cached)
