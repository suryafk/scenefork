"""WebSocket protocol end to end with fake adapters (no credits)."""

from dataclasses import replace

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import contracts, vision
from app.main import create_app
from tests.conftest import street_scene

ORIGIN = {"origin": "http://localhost:5173"}


def client(settings):
    return TestClient(create_app(settings))


def recv_until(ws, kind, limit=20):
    seen = []
    for _ in range(limit):
        msg = ws.receive_json()
        seen.append(msg)
        if msg["type"] == kind:
            return msg, seen
    raise AssertionError(f"no {kind}; saw {[m['type'] for m in seen]}")


def fork(ws, jpeg=None):
    ws.send_json({"type": "fork", "req_id": "r0", "clip_hash": "abc", "t_fork": 1.5})
    ws.send_bytes(jpeg or vision.encode_jpeg(street_scene()))
    msg, _ = recv_until(ws, "forked")
    return msg


def test_fork_then_free_streams_freed_grounded_and_plate(settings):
    c = client(settings)
    with c.websocket_connect("/ws", headers=ORIGIN) as ws:
        hello = ws.receive_json()
        assert hello == {"type": "hello", "live": False, "voice": False}
        forked = fork(ws)
        assert (forked["width"], forked["height"]) == (1280, 720)
        ws.send_json({"type": "free", "req_id": "r1", "fork_id": forked["fork_id"], "x": 450, "y": 420})
        freed, _ = recv_until(ws, "freed")
        entity = freed["entity"]
        assert contracts.is_valid("entity", entity), entity
        assert abs(entity["sprite_bbox"]["x"] - 380) <= 2
        msgs = {}
        while not {"grounded", "plate"} <= msgs.keys():  # they arrive in either order, with spend updates
            m = ws.receive_json()
            msgs[m["type"]] = m
        assert msgs["grounded"]["entity_id"] == entity["id"]
        assert contracts.is_valid("grounding", msgs["grounded"]["grounding"])
        plate = msgs["plate"]
        assert plate["version"] == 1 and plate["method"] == "fake"

        # Signed assets load; a tampered signature does not.
        r = c.get(entity["sprite_url"], headers=ORIGIN)
        assert r.status_code == 200 and r.headers["content-type"] == "image/webp"
        assert r.headers["access-control-allow-origin"] == "http://localhost:5173"
        assert c.get(plate["url"]).status_code == 200
        assert c.get(entity["sprite_url"][:-4] + "0000").status_code == 403


def test_second_free_runs_on_the_updated_plate(settings):
    c = client(settings)
    with c.websocket_connect("/ws", headers=ORIGIN) as ws:
        ws.receive_json()
        forked = fork(ws)
        ws.send_json({"type": "free", "req_id": "r1", "fork_id": forked["fork_id"], "x": 450, "y": 420})
        recv_until(ws, "plate")
        # The truck is gone from the plate now, so the same spot is road/sky, not an object.
        ws.send_json({"type": "free", "req_id": "r2", "fork_id": forked["fork_id"], "x": 920, "y": 540})
        freed, _ = recv_until(ws, "freed")
        assert freed["req_id"] == "r2" and freed["entity"]["id"] == "obj_2"


def test_clicking_the_sky_fails_cleanly(settings):
    with client(settings).websocket_connect("/ws", headers=ORIGIN) as ws:
        ws.receive_json()
        forked = fork(ws)
        ws.send_json({"type": "free", "req_id": "r1", "fork_id": forked["fork_id"], "x": 100, "y": 100})
        failed, _ = recv_until(ws, "free_failed")
        assert failed["reason"] == "no_object" and failed["req_id"] == "r1"


def test_unknown_fork_tells_the_client_to_resend(settings):
    with client(settings).websocket_connect("/ws", headers=ORIGIN) as ws:
        ws.receive_json()
        ws.send_json({"type": "free", "req_id": "r9", "fork_id": "f_gone", "x": 1, "y": 1})
        err, _ = recv_until(ws, "error")
        assert err == {"type": "error", "code": "unknown_fork", "req_id": "r9", "fork_id": "f_gone"}


def test_oversized_frame_is_rejected(settings):
    with client(settings).websocket_connect("/ws", headers=ORIGIN) as ws:
        ws.receive_json()
        ws.send_json({"type": "fork", "req_id": "big"})
        ws.send_bytes(b"\xff" * (2 * 1024 * 1024))
        err, _ = recv_until(ws, "error")
        assert err["code"] == "frame_too_large"


def test_demo_key_is_required_when_set(settings):
    c = client(replace(settings, demo_token="sesame"))
    with pytest.raises(WebSocketDisconnect) as e:
        with c.websocket_connect("/ws?k=wrong", headers=ORIGIN) as ws:
            ws.receive_json()
    assert e.value.code == 4401
    with c.websocket_connect("/ws?k=sesame", headers=ORIGIN) as ws:
        assert ws.receive_json()["type"] == "hello"


def test_foreign_origin_is_rejected(settings):
    with pytest.raises(WebSocketDisconnect) as e:
        with client(settings).websocket_connect("/ws", headers={"origin": "https://evil.example"}) as ws:
            ws.receive_json()
    assert e.value.code == 4403


def test_cancel_before_segmentation_finishes_skips_the_free(settings):
    with client(settings).websocket_connect("/ws", headers=ORIGIN) as ws:
        ws.receive_json()
        forked = fork(ws)
        ws.send_json({"type": "cancel", "req_id": "r1"})
        ws.send_json({"type": "free", "req_id": "r1", "fork_id": forked["fork_id"], "x": 450, "y": 420})
        failed, seen = recv_until(ws, "free_failed")
        assert failed["reason"] == "cancelled"
        assert "freed" not in [m["type"] for m in seen]


def test_codegen_round_trip_with_the_fake_mutator(settings):
    with client(settings).websocket_connect("/ws", headers=ORIGIN) as ws:
        ws.receive_json()
        scene = {"bounds_m": {"width": 12.8, "height": 7.2}, "gravity": [0, 9.81],
                 "entities": [{"id": "truck", "label": "truck", "dynamic": True, "x": 3, "y": 4, "width": 3, "height": 2, "mass_kg": 3500}]}
        ws.send_json({"type": "codegen", "req_id": "c1", "text": "slingshot the truck", "scene": scene,
                      "bindings": {"thisId": None, "thatId": None, "named": ["truck"]}, "attempt": 0, "previous": None})
        msg, _ = recv_until(ws, "codegen_result")
        assert msg["req_id"] == "c1" and msg["problems"] == []
        assert contracts.is_valid("plugin", msg["plugin"])
        assert msg["plugin"]["writes"] == ["entity:truck.velocity"]


@pytest.mark.parametrize(
    "patch",
    [{"attempt": 3, "previous": {"plugin": {}, "error": "x"}}, {"attempt": 1, "previous": None}, {"text": ""}, {"text": "x" * 301}, {"scene": None}],
)
def test_codegen_rejects_bad_requests_without_calling_the_model(settings, patch):
    with client(settings).websocket_connect("/ws", headers=ORIGIN) as ws:
        ws.receive_json()
        ws.send_json({"type": "codegen", "req_id": "c2", "text": "spin", "scene": {"entities": []}, "bindings": {}, "attempt": 0, "previous": None, **patch})
        msg, _ = recv_until(ws, "codegen_failed")
        assert msg["reason"] == "bad_request"
