# CLAUDE TAKEOVER CONTEXT: SceneFork (Meta Global AI Developer Hackathon)

## Project Overview
**Project Title:** SceneFork
**Tagline:** Upload any 10-second video clip. Speak new rules of physics. Play inside your video in the browser.
**Hackathon:** Meta Global AI Developer Hackathon
**Target Tracks:** Build for Your World + Push the Frontier
**Target Bonus Prizes:** Most Viral Project ($20k), Best Agentic Use-Case, Best Build on Meta Open Weight Models, Best Creative Build

---

## What SceneFork Does
SceneFork transforms passive, flat MP4 video clips into interactive, 60 FPS 2.5D physics and audio sandboxes in the browser. 
- **The Core Mechanic ("Timeline Fork"):** At any timestamp $t_{\text{fork}}$, the video freezes, `SAM 3.1` segments all foreground objects into instance masks and convex polygon hulls, `Muse Image` inpaints a clean-plated background behind them, and `Muse Wonder` grounds physical properties (mass, bounce, acoustic material).
- **The Takeover:** The video crossfades into a PixiJS v8 + Rapier2D WebAssembly canvas. Users can grab objects with their mouse, toss them around, and speak voice commands ("Turn this truck into a slingshot") that open-weight `Muse Glimmer` (<90ms) and `Muse Code` compile into live-injected TypeScript physics plugins.

---

## Meta AI Model Stack & Orchestration
1. **`SAM 3.1` (Modal GPU Worker):** Extracts fine-grained instance masks and motion vectors at $t_{\text{fork}}$, feeding an OpenCV Douglas-Peucker polygon simplifier (reducing vertices to 8–16 points for 60 FPS Rapier2D stability) and a 15px morphological shadow dilator.
2. **`Muse Image` (Meta API):** Receives the dilated union foreground mask to inpaint occluded background plates (preventing ghostly holes when moving objects).
3. **`Muse Wonder` (Meta API):** Inspects numbered `SAM 3.1` contours to generate the strict `ScenePhysicsManifest` JSON (mass, friction, restitution, acoustic material).
4. **`Muse Voice Transcribe` + `Muse Glimmer` (Baseten Open Weights):** Streams microphone audio and rolling cursor hover history (`PointerSample[]`) to resolve deictic pronouns ("this truck", "that mug") to exact mask IDs in <90ms.
5. **`Muse Code` (Meta API Agent):** Writes sandboxed TypeScript/JavaScript ECS world mutator plugins (`SceneForkMutator`).
6. **30-Tick Headless Verifier (`HeadlessVerifier.ts`):** Runs every generated `Muse Code` plugin in an isolated off-screen Rapier2D shadow world for 30 ticks (0.5s) in <4ms. If velocity explodes or returns `NaN`, crash telemetry is fed back to `Muse Code` to self-heal automatically before hot-swapping into the live canvas.

---

## Repository File Structure & Current Status
The complete architecture has been prototyped and structured into the following codebase:
- `backend/main.py`: FastAPI WebSocket orchestrator with parallel fan-out (`asyncio.gather`), content-addressed SHA-256 caching for 3 Golden Demo Clips, Glimmer intent routing, and self-healing feedback loops.
- `backend/vision/sam31_hull_compiler.py`: OpenCV hull compiler and shadow dilator.
- `backend/agents/prompts.py`: System prompts for `Muse Wonder` and `Muse Code`.
- `frontend/src/engine/SceneRuntime.ts`: PixiJS v8 + Rapier2D WASM engine, mouse grab-and-throw, and collision event emitter.
- `frontend/src/engine/HeadlessVerifier.ts`: 30-tick shadow verifier critic.
- `frontend/src/engine/ProceduralAudio.ts`: Zero-asset WebAudio synthesizer driven by collision velocity and `acoustic_material` tags.
- `frontend/src/components/VideoForkTimeline.tsx`: Dual-layer video-to-canvas crossfader, deictic ring buffer, and WebSocket client.
- `frontend/src/components/MaskInspectorHUD.tsx`: Judge-facing X-Ray HUD showing per-model latencies and active mutator logs.

---

## Immediate Next Tasks for Claude
If you are taking over as Claude on this project, your immediate objectives are:
1. **Implement Modal GPU Deployment Scripts:** Write the `modal` Python deployment wrapper for `sam31_segmentation` using containerized PyTorch + SAM 3.1 weights.
2. **Setup Baseten Open-Weight Container:** Configure the `Muse Glimmer` / `Muse Spark Open` vLLM inference server deployment script on Baseten.
3. **Write E2E Test Scenarios:** Create Playwright test scripts verifying the WebSocket fork pipeline and self-healing verifier fallback loop.
4. **Prepare Pitch Deck Slides:** Summarize the architecture into 5 killer slides highlighting Impact (30%), Meta Tooling (25%), Technical Depth (20%), and Demo (25%).
