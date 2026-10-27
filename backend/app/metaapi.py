"""Thin async client for the Meta Model API calls SceneFork makes (docs/model-probe.md)."""

import base64
import json

import httpx


def data_url(data: bytes, mime: str) -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode()}"


class MetaModelAPI:
    def __init__(self, api_key: str, base_url: str) -> None:
        if not api_key:
            raise RuntimeError("MODEL_API_KEY is not set; live adapters need it (backend/.env)")
        self._client = httpx.AsyncClient(
            base_url=base_url,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=httpx.Timeout(60.0, connect=10.0),
        )

    async def sam_events(self, image_jpeg: bytes, prompt: str) -> list[dict]:
        """One streamed sam-3.1 request; returns the raw Responses events for meta_sam_parser."""
        body = {
            "model": "sam-3.1",
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": prompt},
                        {"type": "input_image", "image_url": data_url(image_jpeg, "image/jpeg")},
                    ],
                }
            ],
            "stream": True,
        }
        events: list[dict] = []
        async with self._client.stream("POST", "/responses", json=body, headers={"Accept": "text/event-stream"}) as r:
            r.raise_for_status()
            async for line in r.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data = line[6:]
                if data == "[DONE]":
                    break
                events.append(json.loads(data))
        return events

    async def spark_json(self, model: str, effort: str, content: list[dict], schema: dict, name: str) -> tuple[dict, dict]:
        return await self.spark_messages_json(model, effort, [{"role": "user", "content": content}], schema, name)

    async def spark_messages_json(self, model: str, effort: str, messages: list[dict], schema: dict, name: str) -> tuple[dict, dict]:
        r = await self._client.post(
            "/chat/completions",
            json={
                "model": model,
                "reasoning_effort": effort,
                "messages": messages,
                "response_format": {"type": "json_schema", "json_schema": {"name": name, "schema": schema, "strict": True}},
            },
        )
        r.raise_for_status()
        payload = r.json()
        return json.loads(payload["choices"][0]["message"]["content"]), payload.get("usage") or {}

    async def image_edit(self, image_jpeg: bytes, prompt: str) -> bytes:
        r = await self._client.post(
            "/images/edits",
            json={"model": "muse-image-1.0", "prompt": prompt, "images": [{"image_url": data_url(image_jpeg, "image/jpeg")}], "n": 1},
            timeout=180.0,
        )
        r.raise_for_status()
        item = r.json()["data"][0]
        if item.get("b64_json"):
            return base64.b64decode(item["b64_json"])
        img = await self._client.get(item["url"])
        img.raise_for_status()
        return img.content

    async def aclose(self) -> None:
        await self._client.aclose()
