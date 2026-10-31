# Prompt: make the SceneFork hackathon demo video

Paste everything below the line into a new Claude Code session opened in this repo.

---

You are the director, editor and engineer of the 3-minute demo video for **SceneFork**, our entry in the Meta Global AI Developer Hackathon. Your goal is the video most likely to win. It is judged from the recording alone.

**Rubric:** Impact 30%, Meta tooling 25%, Technical depth 20%, Demo 25%. Spend the runtime accordingly. Bonus targets: Most Viral, Best Agentic Use-Case, Best Creative Build.

## Read first

`README.md`, `CLAUDE.md`, `docs/demo-runbook.md`, `docs/demo-video/narration.json`, `frontend/scripts/make-demo.mjs`, `evals/results/mutator-latest.md`, `evals/results/grounding-latest.md`, `shared/presets.json`.

`make-demo.mjs` already drives the real app with Playwright, voices narration, feeds spoken commands in as the microphone, captures the app's impact sounds and mixes with ffmpeg. **Extend it. Don't replace it.** Both it and `narration.json` have uncommitted changes that are the latest work, so keep them.

## What's wrong with the current cut

`demo-out/hackathon_demo_master.mp4` is 2:07. It shows the product well but loses rubric points:

- It has almost no **impact** story and no **large-scale vision**, which together are the biggest rubric category.
- It never gives the **technology stack** beyond the Meta models.
- It skips features: AI rule suggestion chips, "this/that" pointing, "make this bouncy", rule stacking and removal, the repair loop, the shadow verifier's no-op check.
- "Any video" is shown with the desk clip, which is also a golden clip and is AI-generated. A real phone clip is much stronger proof.
- The file is about 800 kbps. Check sharpness: fine outlines and small text must hold up at full screen.

## Before you start, ask me once for

1. A **fresh phone clip** shot for this video, following the rules in `docs/demo-runbook.md` section 1. If I have none, use `desk_01` and remove any claim that the clip is real footage or unseen.
2. `ELEVENLABS_API_KEY` as an environment variable. It must never be written to disk.
3. Whether the repo is public and has a licence. There is no `LICENSE` file today, so **don't say "open source" until there is one**.
4. How to phrase the build time. Commits run from 2026-10-27 to 2026-10-31, which is five calendar days, while the current script says "four days". Use whichever I confirm.

## The story (2:55 to 3:00 total)

| Time | Beat | Rubric | Must show or say |
|---|---|---|---|
| 0:00-0:12 | **Hook** | Demo | No logo or intro. A video plays, freezes, a mug is pulled out of it and thrown. Open on the most surprising moment. |
| 0:12-0:30 | **The problem and what it is** | Impact | Video is the most-watched medium there is, and all of it is read-only. SceneFork turns any paused video into a physical world you can touch and reprogram by voice. |
| 0:30-1:05 | **What it does: real phone clip, live** | Demo, Meta | Upload, pause, fork, click. The object lifts out, the background heals, it gains weight, material and sound. Throw objects into each other. X-Ray on. Name each model at the moment it does its job: SAM 3.1, Muse Image, Muse Spark. |
| 1:05-1:30 | **Voice** | Demo, Meta | Hold Space. "Zero gravity", "Jupiter", "moon gravity". Point and say "make this bouncy". Muse Voice, about 0.45 s to text; presets under 5 ms. |
| 1:30-2:05 | **Rules become code** | Tech, Meta | "Slingshot the phone": writing, testing, installed, launch. An AI suggestion chip runs. "Paint it blue" is refused with a reason. Show the plugin source and its assertions on screen. |
| 2:05-2:25 | **How it stays safe** | Tech | Architecture diagram. Shadow-world verifier, no-op check, up to 2 repairs, sandboxed worker, 300 ms loop kill, 150 ms watchdog restart, rule stack. 48/50 runs; 8/8 grounding. Name the stack. |
| 2:25-2:50 | **Large scale and impact** | Impact | See below. This must feel like the destination, not an appendix. |
| 2:50-3:00 | **Close** | All | Back to the app in motion. Name, one line, repo link, Meta models. Hold the end card for at least 3 s. |

### Features to cover

Cover each one, even for two seconds: video upload, pause and fork, click to free, background repaint, grounded mass/material/bounce, per-surface bounciness, drag to throw, material-based procedural impact sounds, X-Ray HUD, push-to-talk voice, deictic "this/that", presets and one-click gravity buttons (Zero-G, Moon, Mars, Earth, Jupiter), slow motion, reset, AI rule suggestion chips, generated plugins with tests, shadow verifier, repair loop, graceful refusal, rule stacking, sandbox and watchdog. Mention the spend ledger and disk cache only if time allows.

### Technology to name

Verify each against the repo before showing it. Meta: SAM 3.1, Muse Spark 1.3, Muse Image 1.0, Muse Voice Transcribe 1.0. Frontend: React, TypeScript, Vite, Pixi v8, Rapier 2D in WASM, Web Workers, Acorn. Backend: FastAPI, WebSockets, OpenCV. Quality: Vitest, pytest, Playwright, live evals.

### Large-scale implementation and impact

Write this section as a clearly labelled vision: "where this goes", never as things that exist. Use only arguments the project supports:

- **Learning:** a student films something in their own world and tests physics on it. Change gravity and see the result, with no lab and no code.
- **Creators and social video:** a Reel becomes something viewers can play with and remix by talking to it. This is the natural fit with Meta's platforms and the viral angle.
- **Games and simulation:** a phone clip becomes a playable prototype, for people who can't use a game engine.
- **Trusted agents, the deepest point:** "the AI proposes, the simulation decides" is a general pattern. Generated code must pass its own tests in a shadow world before it touches the real one, and that applies wherever agents act on live systems.
- **Why it scales:** physics runs on the viewer's device, so server cost is mainly model calls. Use measured figures: about $0.014 per freed object and about $0.007 per generated rule attempt. Golden clips play from static files with no backend.

Be honest that production needs the work in `TODOS.md` (rate limits, memory caps). Don't put that in the video, but don't claim it's production-ready either.

## Truth rules

These protect the win. A judge who catches one fake moment discounts everything.

- **Everything shown as the product is the real app** running real models: `SCENEFORK_ADAPTERS=live`, header reading "live models". No mock UI, no compositing fake results, no speed-ups that hide latency without saying so. Trims must keep the claim true: if you cut a wait, don't say "instantly".
- **Every number comes from the README or `evals/results/`.** Note that 48/50 was measured on the demo street scene. Invent no market sizes, user counts or adoption figures. If you want an outside statistic, find a source, cite it on screen and tell me.
- Don't say a clip is "my own" or "unseen" unless it is. Don't call an AI-generated clip real.
- The narrator is an ElevenLabs voice, and the on-screen commands are synthesized speech sent through the real microphone path. Avoid lines claiming a human is speaking live, and list this in the video description.

## Script

Rewrite `docs/demo-video/narration.json`, keeping its structure and adding segments as needed. Keep the current lines that work: "The AI proposes. The simulation decides." and "A video you can touch." Write for the ear: short sentences, active voice, no buzzwords such as "revolutionary", "seamless" or "game-changing". Budget about 145 words a minute and about 400 words total, and leave room for silences where the product carries the moment. Update the 45 s X cut and `launch_thread.md` to match.

## Audio

**Voice: ElevenLabs.** Audition three voices from the voice library on the same line: warm, confident, natural, not an announcer. List them with `creative_list_voices`, then choose one and tell me why. Set `ELEVENLABS_VOICE_ID`. Generate through `make-demo.mjs` so caching by text and voice keeps working. Use a clearly different voice for the spoken commands. Estimate credits first with `estimate_only` if you use the connector, and don't regenerate unchanged lines.

**Music: Epidemic Sound.** Use the connected tools (`SearchRecordings`, `EditRecording`, `DownloadRecording`). No vocals. Look for a track that builds: curious and sparse for the hook, lifting at the voice section, biggest at the vision section. Offer me the three best with a preview link and a reason, then fit the chosen one to the final runtime with `EditRecording` (`targetDurationMs`) and align its peak to 2:25. Prefer a WAV. Pass it as `DEMO_MUSIC`. Confirm my Epidemic licence covers this use before publishing, and put the credit in the description if required. Use `SearchSoundEffects` only for transitions; impact sounds must stay the app's own.

**Mix:** narration always clear, music ducked under it, music rising in the pauses. Let the impact sounds punch through on the first throw. Add a beat of near-silence just before the first object lifts out.

## Picture

- Real app footage for at least 70% of the runtime.
- Use Remotion (the `remotion` skills) or the existing page overlays for the architecture diagram, stack and vision scenes. Keep the look consistent with the app. Build the diagram step by step in sync with the narration, adapted from the README's mermaid chart.
- Zoom in on what matters: the HUD going writing, testing, installed; the plugin source; the refusal message. Judges watch this at laptop size.
- Captions must be readable with the sound off and must match the narration. Name each Meta model on screen when it acts.
- Cut on action. Never leave the screen static for more than about 3 s.

## Costs and safety

Follow the `CLAUDE.md` budget rules. Keep live model calls within the spend guard and use the dev cache for repeat takes. A fresh-clip attempt is about $0.05. Stop and ask with an estimate before any batch over $5. Don't commit, push or publish anything unless I ask.

## Before you call it done

1. Render the full video and confirm with `ffprobe`: 2:55 to 3:00, 1080p, 60 fps. Check the bitrate is high enough that text stays sharp.
2. Extract a frame every 5 s and **look at them**. Check for ghost outlines, cut-off captions, overlapping text, debug UI and toasts.
3. Check the audio: measure loudness (target about -16 LUFS, true peak under -1.5 dB), that narration is never buried, and that commands line up with on-screen actions.
4. Check every claim in the script against its source, and give me a table of claim to source.
5. Score the cut against the rubric, one honest line per category, then fix the weakest thing and render again.
6. Run `pnpm --dir frontend e2e` to confirm the recorded build passes.

**Deliver:** `demo-out/hackathon_demo_master.mp4`, the updated X cut, the claim table, the video description with credits, and anything you could not verify.
