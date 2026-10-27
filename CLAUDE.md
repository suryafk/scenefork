# CLAUDE.md

## gstack

Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

## Meta Model API credit budget

The whole project has **$150 of Model API credit**, and it must last through the final demo recording. Spend as little as possible.

- **No live calls in tests.** Unit, integration and E2E tests use fake adapters. Live calls happen only in `scripts/` probes, evals and manual runs.
- **Ask before any batch of more than 20 live calls** (evals, golden-clip export, load tests), and state the estimated cost first.
- **Cache every live response on disk during development**, keyed by a hash of the request, and replay it on a repeat. Never re-pay for the same frame, click or prompt.
- **Cheapest settings that work:**
  - `muse-spark-1.3` in Standard mode with `reasoning_effort="minimal"`; raise it only when an eval shows it's needed.
  - Never use `muse-wonder-1.0` (about 4-5x the price of Spark).
  - No `web_search` tool.
  - SAM on images only, never video (video bills a 50-frame minimum per request).
  - One Muse Image edit per plate.
- **Never use `*-contributor` models,** even though they're cheaper, because Meta trains on what you send.
- **Every backend model call goes through the spend guard** (`backend` SpendLedger): it logs an estimated cost per call to `backend/.spend/ledger.jsonl` and refuses calls once `SPEND_CAP_USD` (default 10 for development) is reached.

Unit prices (docs/model-probe.md):

| Model | Price |
|---|---|
| Spark | $1.25 per 1M input tokens, $4.25 per 1M output |
| SAM | $0.0025 per image |
| Muse Image | $0.01 per image |
| Voice | $0.18 per hour |

Typical costs: a grounding call is about $0.003; a SAM click is $0.0025; a codegen attempt is about $0.01-0.03.
