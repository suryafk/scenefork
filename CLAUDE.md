# CLAUDE.md

## gstack

Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

## Testing

- Frontend (Vitest, headless in Node, with Rapier running in WASM): `pnpm --dir frontend test`
- Typecheck plus production build (also bundles the physics worker): `pnpm --dir frontend build`
- Dev server: `pnpm --dir frontend dev` (the `frontend` entry in `.claude/launch.json`, port 5173)
- Backend (pytest; fake adapters and stubbed API objects, no network, no credits): `cd backend && uv run pytest`
- Backend server: `cd backend && uv run uvicorn app.asgi:app --port 8000` (the `backend` entry in `.claude/launch.json`). It uses free fake models unless `SCENEFORK_ADAPTERS=live` is set in `backend/.env`.
- Contract fixtures in `shared/fixtures/` are checked by both stacks (`backend/tests/test_contracts.py`, `frontend/src/contracts.test.ts`).
- In dev builds, `window.__sfTrace` holds the fork/physics/rules event trace, for browser-driven checks. `window.__sfCommand('slingshot the truck')` runs a voice command without a mic, and `window.__sfDebug` exposes the physics and verifier clients (for example, load a looping plugin to check the watchdog).
- The fake backend's MutatorAgent knows four commands (slingshot, spin, sideways gravity, heavy); anything else comes back as "not possible". Real codegen needs `SCENEFORK_ADAPTERS=live`.
- Playwright E2E (golden clip, live fork, presets, codegen, demo key): `pnpm --dir frontend e2e`. It starts its own fake-model backend on 8001 and frontend on 5174, and uses the installed Google Chrome (no Playwright browser download).
- Muse Voice realtime probe (live, about $0.0003): `cd backend && uv run python scripts/probe_voice.py`.
- Golden clips: `cd backend && uv run python scripts/export_golden.py --help`. Output goes to `frontend/public/golden/` (format: `shared/golden.schema.json`). Runbook and shot list: `docs/demo-runbook.md`.

## Meta Model API credit budget

The whole project has **$150 of Model API credit**, and it must last through the final demo recording. **Up to $75 of it may go to development** (evals, golden-clip exports, live checks; raised by the user on 2026-10-28). The rest is kept for the demo recording. Spend freely within that, but never wastefully.

- **No live calls in tests.** Unit, integration and E2E tests use fake adapters. Live calls happen only in `scripts/` probes, evals and manual runs.
- **Ask before any single batch estimated at over $5** (an eval run, a big export), and state the estimate first. Smaller live runs go ahead without asking; report their cost afterwards.
- **Cache every live response on disk during development**, keyed by a hash of the request, and replay it on a repeat. Never re-pay for the same frame, click or prompt.
- **Cheapest settings that work:**
  - `muse-spark-1.3` in Standard mode with `reasoning_effort="minimal"`; raise it only when an eval shows it's needed.
  - Never use `muse-wonder-1.0` (about 4-5x the price of Spark).
  - No `web_search` tool.
  - SAM on images only, never video (video bills a 50-frame minimum per request).
  - One Muse Image edit per plate.
- **Never use `*-contributor` models,** even though they're cheaper, because Meta trains on what you send.
- **Every backend model call goes through the spend guard** (`backend` SpendLedger): it logs an estimated cost per call to `backend/.spend/ledger.jsonl` and refuses calls once `SPEND_CAP_USD` (default 75, the development allowance; it counts the ledger's all-time total) is reached.

Unit prices (docs/model-probe.md):

| Model | Price |
|---|---|
| Spark | $1.25 per 1M input tokens, $4.25 per 1M output |
| SAM | $0.0025 per image |
| Muse Image | $0.01 per image |
| Voice | $0.18 per hour |

Typical costs: a grounding call is about $0.003; a SAM click is $0.0025; a codegen attempt is about $0.004-0.007 (measured, docs/model-probe.md).
