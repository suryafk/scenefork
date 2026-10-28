# Model probe (Phase 0)

## What the docs say (read 2026-10-27 from dev.meta.ai/docs)

Every hosted model shares one base URL, `https://api.meta.ai/v1`, and one auth: `Authorization: Bearer $MODEL_API_KEY`. Keys start with `LLM_`. The API is drop-in compatible with the OpenAI SDK and the Anthropic SDK.

| SceneFork role | Model on Model API | Endpoint | Key facts | Price |
|---|---|---|---|---|
| Segmenter (click-to-free) | `sam-3.1` | `POST /v1/responses` (streamed) | Takes point and box prompts in the text part: `<0f>1<\|point;x=..;y=..;w=W;h=H\|>`, with negative points via `-`. Concept prompts take one noun phrase per request. Output is `id<\|box..\|><\|mask;data=H,W,~base85\|>` per object; mask rasters are smaller than the frame. TS helpers: `buildObjectPrompt`, `decodeMaskToRaster` (see "SAM client libraries"). | $2.50 / 1k images |
| Inpainter (clean plate) | `muse-image-1.0` | `POST /v1/images/edits` (JSON `images[]`) or Responses | **No mask parameter**: edits are instruction-guided ("remove X, keep the rest"). The output comes back as base64 or a signed URL. Search grounding is built in. | $0.01 / image; 150 RPM |
| PhysicsGrounder, IntentRouter, MutatorAgent | `muse-spark-1.3` (Standard) | `/v1/chat/completions`, `/v1/responses` | Image input; `response_format: json_schema` constrains decoding (no recursive schemas). 1M context. | $1.25 in / $4.25 out per 1M tokens |
| Harder codegen, optional | `muse-wonder-1.0` (preview) | same | Same request shape as Spark, stronger on long agentic work. | $4 in / $20 out per 1M tokens |
| Voice (optional, per OV5) | `muse-voice-transcribe-1.0` | `wss://api.meta.ai/v1/asr/realtime` (`PUSH_TO_TALK` mode, partials) or `POST /v1/asr/transcribe` (multipart WAV, 16 or 24 kHz mono 16-bit) | **Turn-level timestamps only, no word timestamps.** Realtime auth goes in the handshake frame, so the browser must go through the backend proxy (the key never reaches the client). | $0.18 / audio hour |
| Not on Model API | `Muse Glimmer`, `Muse Spark Open` | self-hosted only | Open weights (Glimmer under Apache 2.0). "Muse Code" is a terminal coding agent, not an API model. | n/a |

**Rate limits (per team):** muse-spark-1.3 allows 3,000 RPM and 4M TPM; sam-3.1 allows 3,000 RPM; muse-image-1.0 allows 150 RPM; voice allows 256 concurrent streams. On a 429, back off exponentially with jitter, starting at 500 ms.

**Data use:** in Standard mode, content is not used to train Meta models. `*-contributor` models are cheaper, but Meta trains on what you send. **SceneFork uses Standard mode only**, because judge and user frames must not train models. Voice transcription offers zero data retention at the same price as Standard.

### Design changes this forces
1. **The Segmenter is `sam-3.1` on Model API**, not SAM 3 on Modal. Point prompts map one-to-one onto click-to-free. OV4 (embedding pinning) and the Hugging Face weight request no longer apply. Modal hosts only the FastAPI app.
2. **The Inpainter needs a composite step.** Muse Image may touch pixels outside the object, so the backend keeps the edit result only inside the dilated mask (with a feathered alpha) and keeps the original frame everywhere else. LaMa stays as a fallback if the edit quality fails on the golden clips.
3. **Voice:** Chrome Web Speech stays primary (OV5). Muse Voice Transcribe realtime with PUSH_TO_TALK partials is the Meta-tooling path, proxied through the backend. Neither gives word timestamps, so "this/that" resolves by longest pointer dwell (as designed).
4. **Masks are base85 payloads, not PNGs.** SAM 3.1's TS client library decodes them, so mask decoding can happen in the browser or in the backend's HullCompiler.

## Live probe results

Run `cd backend && uv run python scripts/probe_models.py`. Raw outputs are in `backend/scripts/probe_out/` (gitignored). These results are from a single run on 2026-10-27, from a home network, against a synthetic 1280×720 street scene (a red truck and an orange cone).

| Probe | OK | Latency | Result |
|---|---|---|---|
| `models.list` | yes | 1548 ms | `muse-image-1.0, muse-spark-1.1/1.2/1.3 (+contributor), muse-voice-transcribe-1.0, muse-wonder-1.0, sam-3.1` |
| `muse-spark-1.3` grounding (json_schema + image), default reasoning | yes | 6335 ms | `{label: red_delivery_truck, dynamic, 4000 kg, restitution 0.1, friction 0.8, hollow_metal}`; 1109 output tokens |
| same, `reasoning_effort="low"` | yes | 4114 ms | 2500 kg, 579 output tokens |
| same, `reasoning_effort="minimal"` (3 runs) | yes | 2269 / 3150 / 2359 ms | 2500 kg every run, 196-266 output tokens. (`"none"` returns 400; the allowed values are minimal, low, medium, high, xhigh and max.) |
| `sam-3.1` point prompt (one click on the truck) | yes | 1911 ms | 1 object, box IoU **0.997** with the true truck box; mask 181×322, `!` (one_bit) encoding |
| `sam-3.1` concept prompt "red truck" | yes | 1976 ms | 1 object, box IoU 0.994; mask 180×321, `~` (lossless) encoding |
| `muse-image-1.0` edit "remove the truck, keep every other pixel" | yes | 10451 ms | Truck removed cleanly (sky and road filled). **The output is 2048×1152 WebP, not the input size, and the whole frame is re-rendered:** after resizing to 1280×720 the curb moved from y=470-480 to y=488-497, and the cone moved down about 20px and got about 8% shorter. Mean absolute difference outside the truck is 2.82/255 on this flat-color scene. |
| `muse-voice-transcribe-1.0` file, PUSH_TO_TALK | yes | 5527 ms | "Make the gravity like moon." for "make the gravity like the moon" (1.52 s of `say` audio; dropped "the") |

### What the numbers mean for the plan
1. **Grounding latency:** the design's target was under 1.5s. The best result was about 2.3s at `reasoning_effort="minimal"`. Bodies already release with label defaults before grounding returns (step 5), so this is fine, but **use `minimal`**. At 2-3s the property patch lands after the user has started dragging, so apply mass and material patches smoothly or only once the body is at rest (Open Question 2's fallback). Mass estimates vary by reasoning level (4000 vs 2500 kg), so clamp masses and keep them stable across calls.
2. **The SAM click budget is over.** The design budgeted about 1.2s for segmentation inside a 2.5s click-to-body total; it measured about 1.9s from home. The 2.5s total is still reachable only if hull compile, sprite encode and network stay under about 600ms combined. Mask quality is excellent (IoU 0.997 from a single click). Re-measure from Modal (same-cloud latency may be lower) before changing the target.
3. **The Muse Image composite needs alignment.** It isn't an in-place inpainter: it re-renders and slightly re-frames the whole image (about 20px vertical shift here). A naive "paste the edit inside the dilated mask" would leave seams wherever lines cross the mask edge (the curb, in this scene). Options for Phase 2:
   - (a) Register the edit to the source frame before compositing, using OpenCV ECC or feature-based affine on the unmasked area.
   - (b) Use LaMa on Modal for live-clip plates, and keep Muse Image for golden plates, which are hand-touched anyway (OV9).
   - (c) Both, with (a) as primary and (b) as the fallback.

   Also: about 10.5s per edit means live plates arrive well after the object lifts. The blurred patch placeholder (step 6) is needed, not optional.
4. **Voice:** the file endpoint took about 5.5s for 1.5s of audio, too slow for presets, which confirms OV5 (Chrome Web Speech primary). The realtime WebSocket with partials remains untested; probe it in Phase 3 before choosing it for the Meta-tooling story.
5. **Cost of this probe run:** about 2 Spark calls plus 3 more runs, 2 SAM images, 1 edit and 1.5s of audio, which comes to roughly $0.03 [estimated from the pricing table].

## Phase 2 live smoke test (2026-10-27, demo street, full stack)

Run through the real app (browser → WebSocket → live adapters), with `SPEND_CAP_USD=1`. Total: **$0.0433** (3 SAM clicks, 3 groundings, 3 Muse Image edits).

| Click | SAM 3.1 (click to freed) | Outline | Grounding (muse-spark-1.3, minimal) | Clean plate (muse-image-1.0) |
|---|---|---|---|---|
| Truck | 2.56 s | 7 vertices, matches the truck | `delivery_truck`, 3500 kg, hollow_metal, 2.8 m | Truck removed cleanly, but the whole scene was re-rendered (see below) |
| Road just below a cone (a bad click) | 5.2 s (queued behind the truck) | 36 vertices: the entire road + sidewalk strip | `delivery truck`, 3500 kg (wrong: the huge outline confused it) | Composite shows white speckles across the strip |
| Small cone (fresh fork) | 1.92 s | 33 vertices, matches the cone | `traffic cone`, plastic, 0.5 kg, 0.7 m | Hole fills cleanly, with a faint dark smudge at the road edge |

### Findings
1. **SAM 3.1 point prompts are reliable on real objects.** It took 1.9-2.6 s per click from home, and outlines matched both objects.
2. **Grounding is good when the outline is an object** (truck and cone labels, masses and materials are all sensible) and garbage when the outline is background.
3. **Muse Image regenerates the entire frame**, not just the marked area. In all three edits the buildings came back in a different layout, objects outside the marked area moved, and the large edit also deleted the other objects and redrew the buildings taller. Aligning the edit before pasting it back cannot fix changed content. So the paste is only clean when the hole is small and its surroundings are simple (the cone), and it shows seams or speckles for large holes.
4. **Background slips through the reject rules:** the road/sidewalk strip touched only one frame edge and covered under 60%, so it was accepted as an object.

### Recommended fixes (done 2026-10-27, see below)
- **Crop before editing:** send Muse Image only the area around the hole (the bounding box plus about 50% margin, at the crop's own resolution), so there is less scene for it to re-imagine. Then align and paste the crop back. Same $0.01 per edit.
- **Golden plates stay offline and hand-touched (OV9).** Use Telea, or a cropped Muse edit, for live clips.
- **Reject masks wider than about 75% of the frame** (ground and sidewalk strips), and objects that grounding returns as `fixed` with a label like road, sidewalk, sky or wall.


### Re-check after the fixes (2026-10-27)
- **Cropped edit:** Muse Image now only sees the region's neighborhood (the bounding box plus 50% margin on each side, at least 256px, so 640×360 for the truck). Freeing the truck again gave a background where the buildings continue naturally behind it, with the same windows and layout as the original, and the nearby cone untouched. Remaining flaws: the curb in the filled area sits a few pixels off at the crop edge, and a faint shadow smudge stays on the road. That's good enough for live clips; golden clips still get hand-touched plates (OV9).
- SAM and grounding replayed from the dev cache (free). The only charge was the edit: **$0.01**. Ledger total for Phase 2: **$0.0533**.
- **Background reject:** masks wider than 75% of the frame are refused (the road strip was 79%), and labels naming scenery (road, sidewalk, wall and so on) are pinned `fixed`. Both are tested on fakes.

## Phase 3 live codegen check (2026-10-28, demo street, full stack)

Run through the real app (typed commands → WebSocket → MutatorAgent on `muse-spark-1.3`, `reasoning_effort="minimal"` → verifier worker in the browser), with `SPEND_CAP_USD=1`. Total: **$0.0177** for 3 calls. Ledger total after Phase 3: **$0.071**.

| Command | Spark time | Tokens in / out | Cost | Result |
|---|---|---|---|---|
| "slingshot the truck" | 5.0 s | 2619 / 803 | $0.0067 | Passed on the first attempt (1 dragRelease assertion, 34 ms in the verifier). Live: pulled back to x=3.0 m and released, the truck flew right to 8.4 m. |
| "spin the cone" | 5.1 s | 2623 / 835 | $0.0068 | Passed on the first attempt (2 spin assertions, 9 ms). Spun both cones (the label matched two entities), about 11-12 rad/s live. |
| "paint the truck blue" | 2.5 s | 2616 / 209 | $0.0042 | Declined as infeasible with a clear reason, no repair rounds. |

Findings:
1. **3 of 3 behaved correctly on the first attempt.** No repairs were needed, so the repair path is still only exercised by the Vitest suite.
2. **A codegen attempt costs about $0.004-0.007**, below the $0.01-0.03 estimate. The prompt is about 2.6k tokens, and most of it is `shared/ctx.d.ts`.
3. The infeasible reason ran past the schema's 200-character limit. Prose fields are now trimmed on the backend instead of triggering a schema problem.
4. The generated code respects the sandbox rules (no `undefined`, no computed member access, `== null` checks), and declared write sets matched its writes.
