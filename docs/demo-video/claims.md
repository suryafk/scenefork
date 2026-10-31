# Claim table for the demo video

Every claim in the narration and on screen, and where it comes from.

| Claim | Where it appears | Source | Status |
|---|---|---|---|
| "We spend hours watching video, and all of it is read-only" | Narration | None: a plain observation with no figure, kept as an opinion. The prompt's "most watched medium" was dropped because no source was checked. | Unsourced, no number |
| SAM 3.1 outlines from one click | Narration, tag | README, "How it works" | OK |
| Muse Image repaints the background | Narration, tag | README, "How it works" | OK |
| Muse Spark gives mass, material, bounce | Narration, tag | README; grounding schema | OK |
| "Live, each repaint takes about 20 s" | On-screen note | `backend/.spend/ledger.jsonl`: Muse Image calls 16-22 s apart in the first live run. `backend/app/session.py` says 10-20 s. | OK |
| Each object sounds like what it is | Narration | README; `frontend/src/audio/ProceduralAudio.ts` | OK |
| X-Ray shows collision shapes and centers of mass | Narration | Visible in the take; README | OK |
| "Muse Voice gets you text in about half a second" | Narration | README, Measured: ~0.45 s, key-up to final transcript | OK |
| "Presets apply in under five milliseconds" | Narration, diagram | README, section "Rules that are tested"; `shared/presets.json` | OK |
| Muse Spark writes a program plus its own tests | Narration | README; the plugin source and assertions on screen are the real take's | OK, shown live |
| A shadow copy runs tests before the rule touches the scene | Narration | README, step 3 | OK, shown live |
| "A rule that does nothing is rejected" | Narration, diagram, callout | README, step 3; the no-op rejection is the real take | OK, shown live |
| "A failed test goes back to the model, up to twice" | Narration, diagram | README, step 4 (up to 2 repairs) | OK |
| Refuses "paint it blue" and says why | Narration | Real take: "not possible with this API" | OK, shown live |
| "The AI proposes. The simulation decides." | Narration, card | Project line | OK |
| Suggested rule chips from the scene | Narration | README, "Not sure what to say?" | OK, shown live |
| Rules stack, and removing one restores what was there | Narration, diagram | README, "Rules stack" | OK |
| "In a worker with no network" | Narration, diagram | README: no DOM, network APIs removed | OK |
| "Stuck plugins die in three hundred milliseconds" | Narration, diagram | README: killed after 300 ms | OK |
| 150 ms watchdog restart | Diagram only | README: restarts within 150 ms | OK; not demonstrated in the video |
| 1 verifier kill | HUD, tag | Real: the runbook's looping plugin sent to the real verifier | OK; a deliberate test, disclosed |
| "On our demo scene, forty-eight of fifty generated rules passed" | Narration, diagram | `evals/results/mutator-latest.md`: 48/50, demo street | OK; the narration says "demo scene" |
| 8 of 8 objects | Diagram | `evals/results/grounding-latest.md`: 8/8 | OK |
| React, Pixi, Rapier, FastAPI, OpenCV and the rest of the stack | Narration, diagram | `frontend/package.json`, `backend/pyproject.toml`, README | OK, checked |
| Rapier in WASM | Diagram | `@dimforge/rapier2d-compat`; CLAUDE.md | OK |
| Physics runs on the viewer's device | Narration, card | README: browser physics worker | OK |
| "About a cent and a half per object", $0.014 | Narration, card | `docs/demo-runbook.md`: about $0.014 per object | OK |
| $0.007 per rule attempt | Card | README, Measured | OK |
| Learning, Reels, games, trusted agents | Narration, cards | The prompt's vision list; labelled "Vision, not yet built" | Vision, not a claim of fact |
| "Built solo" | Narration, end card | `git log`: one author | OK |
| "In four days" | Narration, end card | Your confirmed wording. Commits span 2026-10-27 to 2026-10-31. | Your call |
| "Open source, on GitHub" | Narration | Repo is public; MIT `LICENSE` added locally | **True only once `LICENSE` is pushed** |
| "made with AI for this test" | Narration | The clip's watermark and Google C2PA signature | OK |
