# Evals

Unit and E2E tests use fake models, so they can't tell whether Muse Spark writes plugins that work or guesses sane masses. These two suites run the real models on fixed cases and score them (eng review D11). Run them at milestones and after any prompt change (OV11); both ask nothing of you beyond a live backend, and their spend goes through the SpendLedger.

| Suite | Cases | Command | Bar | Cost |
|---|---|---|---|---|
| Mutator | `mutator_cases.json`: 10 commands (8 to build, 2 to decline) | start the backend with `SCENEFORK_ADAPTERS=live`, then `pnpm --dir frontend eval:mutator -- --runs 5` | 4/5 runs per command | ~$0.35 first run, aborts at `--max-usd` (default 2) |
| Grounding | `grounding_cases.json`: every golden object | `cd backend && SCENEFORK_ADAPTERS=live uv run python scripts/eval_grounding.py` | 90% of objects | ~$0.0015 per object |

Every live response is cached (each mutator run has its own variant number in the cache key), so re-running either suite replays the same samples for free. To draw new samples, change the prompt or use new run numbers.

The mutator suite drives the app's own generate → verify → repair loop (`RuleController.build`) on the demo street, with each verification in a child process that's killed after 5 s, the stand-in for the app's 300 ms verifier-worker kill.

Latest results: [`results/mutator-latest.md`](results/mutator-latest.md), [`results/grounding-latest.md`](results/grounding-latest.md). Raw per-run JSON sits beside them.
