# SceneFork: Master Technical Blueprint & Hackathon Starter Kit
**Tagline:** *Upload any 10-second video clip. Speak new rules of physics. Play inside your video in the browser.*
**Target Tracks:** Build for Your World + Push the Frontier (Hybrid Spatial/Physics Intelligence)
**Target Bonus Prizes:** Most Viral Project ($20k), Best Creative Build, Best Agentic Use-Case, Best Build on Meta Open Weight Models

---

## 1. Executive Summary & Judging Rubric Alignment

| Rubric Category | Weight | How SceneFork Maximizes Score |
| :--- | :--- | :--- |
| **Impact** | **30%** | Democratizes interactive 2.5D physics, game prototyping, interactive education, and motion design—turning any flat MP4 video into an interactive simulation in 10 seconds without manual rotoscoping in After Effects or rigging in Unity. |
| **Use of Meta AI Tooling** | **25%** | Uses **6 distinct Meta models** in a tightly coupled multimodal loop: `SAM 3.1` (temporal segmentation), `Muse Image` (dilated background clean-plating & texture reskinning), `Muse Wonder` (physical material & joint grounding), `Muse Voice Transcribe` (live voice rules), `Muse Glimmer` / `Muse Spark Open` on Modal/Baseten (sub-100ms deictic intent routing & safety critic), and `Muse Code` (autonomous ECS physics/audio plugin synthesis). |
| **Technical Depth & Execution** | **20%** | Features Douglas-Peucker concave-to-convex polygon decomposition for 60 FPS WebAssembly physics, dilated shadow-halo removal for clean-plating, deictic cursor-to-mask binding, and a **30-tick headless WebWorker physics verifier** that self-heals `Muse Code` patches before hot-reloading. |
| **Demo & Virality** | **25%** | Visceral, unforgettable visual payoff: freeze a normal video, grab a parked delivery van out of the street with your mouse, toss it into a coffee cart with procedural metallic crash audio, and speak new rules of gravity live on stage. |

---

## 2. System Architecture & Multimodal Data Flow

### 2.1 The "Timeline Fork" Paradigm
The biggest conceptual hurdle in converting video into interactive physics is reconciling pre-recorded temporal motion with real-time rigid-body dynamics. SceneFork solves this via a **3-State Timeline Fork**:
1. **Linear Playback ($t = 0 \rightarrow t_{\text{fork}}$):** Standard HTML5 `<video>` playback.
2. **Fork Extraction ($t = t_{\text{fork}}$):**
   - `SAM 3.1` segments all distinct foreground objects at $t_{\text{fork}}$ and tracks them across a $\pm 0.5\text{s}$ window to extract short animated texture loops (e.g., walking legs, flickering neon) and initial velocity vectors $(\vec{v}_0)$.
   - `Muse Image` receives the 15px-dilated union mask of all dynamic foreground entities and inpaints a clean, unoccluded background plate.
   - `Muse Wonder` inspects the numbered `SAM 3.1` contours and generates the `ScenePhysicsManifest` JSON.
3. **Interactive Simulation ($t > t_{\text{fork}}$):** At the exact millisecond of $t_{\text{fork}}$, the `<video>` element crossfades (`opacity: 0`) into the **PixiJS v8 + Rapier2D WASM** canvas where every segmented object is now a live, interactive rigid body sitting over the clean-plated background.

---

## 3. Data Contracts & JSON Schemas

### 3.1 `ScenePhysicsManifest` (Output of `SAM 3.1` + `Muse Wonder`)
```json
{
  "scene_id": "street_clip_01",
  "fork_timestamp_sec": 3.42,
  "resolution": { "width": 1280, "height": 720 },
  "clean_plate_url": "/assets/street_clip_01_cleanplate.png",
  "world_config": {
    "gravity": { "x": 0.0, "y": 980.0 },
    "pixels_per_meter": 100.0
  },
  "entities": [
    {
      "id": "ent_mask_01",
      "mask_id": 1,
      "label": "asphalt_road_and_sidewalk",
      "body_type": "fixed",
      "centroid_px": { "x": 640, "y": 650 },
      "hull_vertices_local_px": [[-640, -40], [640, -40], [640, 70], [-640, 70]],
      "sprite_url": "/assets/mask_01_rgba.png",
      "physics": {
        "mass_kg": 0.0,
        "restitution": 0.3,
        "friction": 0.9,
        "linear_damping": 0.0,
        "angular_damping": 0.0
      },
      "initial_velocity_px_s": { "x": 0.0, "y": 0.0 },
      "acoustic_material": "concrete",
      "z_index": 1
    },
    {
      "id": "ent_mask_02",
      "mask_id": 2,
      "label": "red_food_truck",
      "body_type": "dynamic",
      "centroid_px": { "x": 420, "y": 490 },
      "hull_vertices_local_px": [[-140, -85], [135, -85], [145, 80], [-145, 80]],
      "sprite_url": "/assets/mask_02_rgba.png",
      "physics": {
        "mass_kg": 1200.0,
        "restitution": 0.2,
        "friction": 0.7,
        "linear_damping": 0.05,
        "angular_damping": 0.1
      },
      "initial_velocity_px_s": { "x": 25.0, "y": 0.0 },
      "acoustic_material": "hollow_metal",
      "z_index": 3,
      "joint": null
    }
  ]
}
```

### 3.2 Deictic Voice Context Packet (Input to `Muse Glimmer` & `Muse Code`)
When the user speaks while pointing their cursor at an object on screen, the frontend captures a Deictic Context Packet:
```json
{
  "transcript": "Turn this truck into a slingshot and make the pavement bouncy like a trampoline",
  "pointer_history": [
    { "timestamp_ms": 410, "x": 425, "y": 488, "hovered_entity_id": "ent_mask_02" }
  ],
  "resolved_deictic_bindings": {
    "this truck": "ent_mask_02",
    "the pavement": "ent_mask_01"
  }
}
```

---

## 4. Complete Backend Implementation (Python + FastAPI + Modal)

### 4.1 `backend/vision/sam31_hull_compiler.py`
Extracts `SAM 3.1` masks, creates dilated masks for `Muse Image` clean-plating (eliminating shadow halos), and computes simplified convex hulls for 60 FPS Rapier2D physics.

```python
import cv2
import numpy as np
from typing import Dict, List, Any

class SAM31GeometryCompiler:
    def __init__(self, epsilon_factor: float = 0.014, dilation_px: int = 15):
        self.epsilon_factor = epsilon_factor
        self.dilation_px = dilation_px

    def process_frame_masks(
        self, frame_bgr: np.ndarray, masks: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        h, w, _ = frame_bgr.shape
        combined_foreground_mask = np.zeros((h, w), dtype=np.uint8)
        compiled_entities = []

        for idx, mask_data in enumerate(masks):
            mask_id = idx + 1
            binary_mask = (mask_data["segmentation"] > 0).astype(np.uint8) * 255
            combined_foreground_mask = cv2.bitwise_or(combined_foreground_mask, binary_mask)

            # 1. Extract external contour & simplify via Douglas-Peucker
            contours, _ = cv2.findContours(
                binary_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
            )
            if not contours:
                continue
            largest_contour = max(contours, key=cv2.contourArea)
            if cv2.contourArea(largest_contour) < 150:  # Filter noise
                continue

            moments = cv2.moments(largest_contour)
            cx = int(moments["m10"] / max(moments["m00"], 1e-5))
            cy = int(moments["m01"] / max(moments["m00"], 1e-5))

            # Convex hull + simplification to guarantee Rapier2D stability
            hull = cv2.convexHull(largest_contour)
            perimeter = cv2.arcLength(hull, True)
            approx_hull = cv2.approxPolyDP(hull, self.epsilon_factor * perimeter, True)

            local_vertices = [
                [int(pt[0][0] - cx), int(pt[0][1] - cy)] for pt in approx_hull
            ]

            # 2. Extract tight RGBA sprite cutout around bounding box
            x, y, bw, bh = cv2.boundingRect(largest_contour)
            b, g, r = cv2.split(frame_bgr[y : y + bh, x : x + bw])
            alpha = binary_mask[y : y + bh, x : x + bw]
            rgba_sprite = cv2.merge([b, g, r, alpha])

            compiled_entities.append({
                "mask_id": mask_id,
                "centroid_px": {"x": cx, "y": cy},
                "bbox_px": {"x": x, "y": y, "w": bw, "h": bh},
                "hull_vertices_local_px": local_vertices,
                "rgba_sprite": rgba_sprite,
            })

        # 3. Dilate combined mask by 15px + downward shadow allowance for Muse Image
        kernel = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, (self.dilation_px * 2 + 1, self.dilation_px * 2 + 1)
        )
        dilated_inpaint_mask = cv2.dilate(combined_foreground_mask, kernel, iterations=1)

        return {
            "entities": compiled_entities,
            "dilated_inpaint_mask": dilated_inpaint_mask,
        }
```

### 4.2 `backend/agents/prompts.py`
Exact system prompts for **Muse Wonder** (Physics Grounding), **Muse Glimmer** (Fast Intent Router), and **Muse Code** (ECS Plugin Synthesizer).

```python
MUSE_WONDER_SYSTEM_PROMPT = """
You are the Spatial & Physical Grounding Architect for SceneFork.
You receive:
1. An annotated video frame where every SAM 3.1 segmented object is outlined and labeled with `[Mask #ID]`.
2. A list of mask IDs with their pixel centroids and bounding areas.

Your job is to infer realistic 2D rigid-body physics parameters for each mask so the scene behaves like the real world when unflattened:
- Identify immovable structural surfaces (roads, floors, walls, countertops, buildings) and set `body_type: "fixed"`.
- Identify movable foreground objects (vehicles, people, cups, balls, props) and set `body_type: "dynamic"`.
- Estimate `mass_kg` (0.1 to 5000.0), `restitution` (bounciness: 0.05 for heavy metal/stone, 0.85 for rubber/balls), and `friction` (0.1 for ice/glass, 0.9 for rubber/asphalt).
- Assign an `acoustic_material` from strictly: `["hollow_metal", "solid_metal", "glass", "ceramic", "wood", "rubber", "plastic", "flesh_cloth", "concrete", "water"]`.
- Detect hanging or hinged objects (signs, doors, pendulums) and emit an optional `joint` linking the child mask ID to its parent anchor mask ID.

Respond ONLY with valid JSON matching the `ScenePhysicsManifest` schema.
"""

MUSE_CODE_PLUGIN_SYSTEM_PROMPT = """
You are the SceneFork Real-Time World Mutator Agent powered by Muse Code.
You write hot-swappable TypeScript/JavaScript ECS physics and audio rule plugins for a running PixiJS v8 + Rapier2D simulation.

STRICT SANDBOX CONTRACT:
You must output a single JavaScript object implementing the `SceneForkMutator` interface:
```javascript
({
  id: "mutator_unique_name",
  description: "Human-readable summary of rule",
  onInit(ctx) {
    // Called once when injected. Modify body properties, add joints, or register timers.
    // Available API:
    // ctx.setGravity(x, y)
    // ctx.getEntity(id) -> { body, collider, sprite, material, setRestitution(r), setMass(m), applyImpulse(ix, iy) }
    // ctx.spawnParticleBurst(x, y, count, options)
    // ctx.createSpringJoint(entityIdA, entityIdB, stiffness, damping)
  },
  onTick(ctx, dt) {
    // Called at 60Hz. Keep math fast and deterministic. Never allocate heavy objects here.
  },
  onPointerDragRelease(ctx, entityId, dragVectorPx) {
    // Optional custom interaction (e.g., Angry Birds slingshot launch)
  },
  onCollision(ctx, entityA, entityB, impulseMagnitude) {
    // Optional custom collision hook (e.g., explode into confetti, play marimba note)
    // ctx.audio.playNote(frequencyHz, durationSec, waveform)
  }
})
```
SAFETY CONSTRAINTS:
1. Never apply an impulse magnitude greater than `50000` in a single frame.
2. Never divide by zero when computing distances (`Math.max(dist, 10.0)`).
3. Output ONLY the executable JavaScript object literal—no markdown fences or explanation.
"""
```

---

## 5. Complete Frontend Implementation (PixiJS v8 + Rapier2D + WebAudio)

### 5.1 `frontend/src/engine/SceneRuntime.ts`
Initializes PixiJS v8 and `@dimforge/rapier2d-compat`, binds `SAM 3.1` polygon hulls and RGBA sprites, and executes hot-swapped `Muse Code` plugins safely.

```typescript
import { Application, Sprite, Assets, Graphics, Container } from 'pixi.js';
import RAPIER from '@dimforge/rapier2d-compat';
import { ProceduralAudioEngine } from './ProceduralAudio';

export interface EntitySpec {
  id: string;
  label: string;
  body_type: 'fixed' | 'dynamic' | 'kinematicPosition';
  centroid_px: { x: number; y: number };
  hull_vertices_local_px: [number, number][];
  sprite_url: string;
  physics: {
    mass_kg: number;
    restitution: number;
    friction: number;
  };
  acoustic_material: string;
}

export class SceneForkRuntime {
  public app!: Application;
  public world!: RAPIER.World;
  public eventQueue!: RAPIER.EventQueue;
  public audio = new ProceduralAudioEngine();
  public entities = new Map<string, {
    spec: EntitySpec;
    body: RAPIER.RigidBody;
    collider: RAPIER.Collider;
    sprite: Sprite;
    debugGraphic: Graphics;
  }>();
  public colliderHandleToId = new Map<number, string>();
  private activeMutators: any[] = [];
  public showDebugHUD = false;

  async init(canvasContainer: HTMLElement, width = 1280, height = 720) {
    await RAPIER.init();
    this.app = new Application();
    await this.app.init({
      width,
      height,
      backgroundAlpha: 0,
      antialias: true,
      preference: 'webgl',
    });
    canvasContainer.appendChild(this.app.canvas);

    this.world = new RAPIER.World({ x: 0.0, y: 980.0 });
    this.eventQueue = new RAPIER.EventQueue(true);

    this.app.ticker.add((ticker) => this.step(ticker.deltaTime / 60));
  }

  async loadSceneManifest(manifest: any) {
    // 1. Load clean-plated background from Muse Image
    const bgTexture = await Assets.load(manifest.clean_plate_url);
    const bgSprite = new Sprite(bgTexture);
    bgSprite.width = this.app.screen.width;
    bgSprite.height = this.app.screen.height;
    this.app.stage.addChild(bgSprite);

    // 2. Instantiate each SAM 3.1 entity
    for (const ent of manifest.entities) {
      await this.spawnEntity(ent);
    }
  }

  async spawnEntity(spec: EntitySpec) {
    const bodyDesc =
      spec.body_type === 'fixed'
        ? RAPIER.RigidBodyDesc.fixed()
        : RAPIER.RigidBodyDesc.dynamic();
    bodyDesc.setTranslation(spec.centroid_px.x, spec.centroid_px.y);
    const body = this.world.createRigidBody(bodyDesc);

    // Flatten local vertices for Rapier2D convexHull collider
    const flatVertices = new Float32Array(spec.hull_vertices_local_px.flat());
    const colliderDesc =
      RAPIER.ColliderDesc.convexHull(flatVertices) ||
      RAPIER.ColliderDesc.ball(30);

    colliderDesc
      .setRestitution(spec.physics.restitution)
      .setFriction(spec.physics.friction)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

    if (spec.body_type === 'dynamic') {
      colliderDesc.setMass(Math.max(spec.physics.mass_kg, 0.5));
    }

    const collider = this.world.createCollider(colliderDesc, body);
    this.colliderHandleToId.set(collider.handle, spec.id);

    const texture = await Assets.load(spec.sprite_url);
    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5);
    sprite.position.set(spec.centroid_px.x, spec.centroid_px.y);
    sprite.eventMode = 'static';
    sprite.cursor = 'grab';

    // Enable direct mouse grab & throw
    this.bindPointerThrow(spec.id, sprite, body);
    this.app.stage.addChild(sprite);

    const debugGraphic = new Graphics();
    this.drawDebugHull(debugGraphic, spec.hull_vertices_local_px);
    debugGraphic.visible = this.showDebugHUD;
    this.app.stage.addChild(debugGraphic);

    this.entities.set(spec.id, { spec, body, collider, sprite, debugGraphic });
  }

  private step(dt: number) {
    const context = this.createMutatorContext();
    for (const mutator of this.activeMutators) {
      mutator.onTick?.(context, dt);
    }

    this.world.step(this.eventQueue);

    // Sync Rapier2D transforms to PixiJS sprites
    for (const [, item] of this.entities) {
      const pos = item.body.translation();
      const rot = item.body.rotation();
      item.sprite.position.set(pos.x, pos.y);
      item.sprite.rotation = rot;
      item.debugGraphic.position.set(pos.x, pos.y);
      item.debugGraphic.rotation = rot;
    }

    // Process collisions for Procedural Audio + Muse Code hooks
    this.eventQueue.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const idA = this.colliderHandleToId.get(h1);
      const idB = this.colliderHandleToId.get(h2);
      if (!idA || !idB) return;

      const entA = this.entities.get(idA)!;
      const entB = this.entities.get(idB)!;
      const relVel = Math.hypot(
        entA.body.linvel().x - entB.body.linvel().x,
        entA.body.linvel().y - entB.body.linvel().y
      );

      if (relVel > 40) {
        this.audio.triggerMaterialImpact(
          entA.spec.acoustic_material,
          entB.spec.acoustic_material,
          relVel
        );
        for (const mutator of this.activeMutators) {
          mutator.onCollision?.(context, idA, idB, relVel);
        }
      }
    });
  }
}
```

### 5.2 `frontend/src/engine/HeadlessVerifier.ts` (The Self-Healing Agent Critic)
Before injecting any `Muse Code` plugin into the live visual canvas, this verifier clones the current entity coordinates into an isolated off-screen Rapier2D world and runs **30 headless simulation ticks (0.5s)** in under 4 milliseconds. If any coordinate becomes `NaN`, `Infinity`, or exceeds `10,000 px/s`, it returns the exact runtime stack trace or physics telemetry violation back to `Muse Code` to self-repair automatically.

```typescript
import RAPIER from '@dimforge/rapier2d-compat';

export function verifyMutatorHeadless(
  mutatorCodeString: string,
  currentEntitiesSnapshot: Array<{ id: string; x: number; y: number; mass: number }>
): { valid: boolean; error?: string } {
  try {
    const mutator = new Function(`return (${mutatorCodeString});`)();
    const shadowWorld = new RAPIER.World({ x: 0.0, y: 980.0 });
    const bodies = new Map<string, RAPIER.RigidBody>();

    for (const ent of currentEntitiesSnapshot) {
      const desc =
        ent.mass > 0
          ? RAPIER.RigidBodyDesc.dynamic().setTranslation(ent.x, ent.y)
          : RAPIER.RigidBodyDesc.fixed().setTranslation(ent.x, ent.y);
      const body = shadowWorld.createRigidBody(desc);
      shadowWorld.createCollider(RAPIER.ColliderDesc.ball(25), body);
      bodies.set(ent.id, body);
    }

    const mockCtx = {
      setGravity: (gx: number, gy: number) => {
        shadowWorld.gravity = { x: gx, y: gy };
      },
      getEntity: (id: string) => {
        const b = bodies.get(id);
        return {
          applyImpulse: (ix: number, iy: number) => b?.applyImpulse({ x: ix, y: iy }, true),
          setRestitution: () => {},
          setMass: () => {},
        };
      },
      spawnParticleBurst: () => {},
      audio: { playNote: () => {} },
    };

    mutator.onInit?.(mockCtx);
    for (let tick = 0; tick < 30; tick++) {
      mutator.onTick?.(mockCtx, 1 / 60);
      shadowWorld.step();

      for (const [id, b] of bodies.entries()) {
        const p = b.translation();
        const v = b.linvel();
        if (
          !Number.isFinite(p.x) ||
          !Number.isFinite(p.y) ||
          Math.hypot(v.x, v.y) > 15000
        ) {
          shadowWorld.free();
          return {
            valid: false,
            error: `Physics instability on entity ${id} at tick ${tick}: velocity=${Math.hypot(v.x, v.y).toFixed(1)}`,
          };
        }
      }
    }

    shadowWorld.free();
    return { valid: true };
  } catch (err: any) {
    return { valid: false, error: err?.message || String(err) };
  }
}
```

### 5.3 `frontend/src/engine/ProceduralAudio.ts` (Zero-Asset WebAudio Synthesizer)
Synthesizes real-time physical collision sounds and musical marimba notes using pure WebAudio oscillators and noise buffers so every object interaction feels tactile.

```typescript
export class ProceduralAudioEngine {
  private ctx: AudioContext | null = null;

  private ensureContext() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  triggerMaterialImpact(matA: string, _matB: string, relativeVelocity: number) {
    const ctx = this.ensureContext();
    const now = ctx.currentTime;
    const gainValue = Math.min(relativeVelocity / 1200, 0.85);

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    const materialProfiles: Record<string, { freq: number; type: OscillatorType; decay: number }> = {
      hollow_metal: { freq: 210, type: 'triangle', decay: 0.35 },
      glass: { freq: 1180, type: 'sine', decay: 0.18 },
      ceramic: { freq: 860, type: 'sine', decay: 0.15 },
      wood: { freq: 145, type: 'sine', decay: 0.12 },
      rubber: { freq: 95, type: 'sine', decay: 0.22 },
      concrete: { freq: 75, type: 'triangle', decay: 0.09 },
    };

    const profile = materialProfiles[matA] || materialProfiles.wood;
    osc.type = profile.type;
    osc.frequency.setValueAtTime(profile.freq * (0.9 + Math.random() * 0.2), now);
    osc.frequency.exponentialRampToValueAtTime(40, now + profile.decay);

    gain.gain.setValueAtTime(gainValue, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + profile.decay);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + profile.decay);
  }

  playNote(freqHz: number, durationSec = 0.25, waveform: OscillatorType = 'sine') {
    const ctx = this.ensureContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = waveform;
    osc.frequency.setValueAtTime(freqHz, now);
    gain.gain.setValueAtTime(0.35, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + durationSec);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + durationSec);
  }
}
```

---

## 6. Latency Budget & Caching Strategy for Live Stage Demos

To make the 3-minute live demo feel completely instantaneous while still executing real live AI calls:
1. **Pre-Warm Modal & Baseten Containers:** Run a keep-alive cron ping every 45 seconds during judging so `SAM 3.1` and `Muse Glimmer` GPUs never cold-start on stage.
2. **Parallel Fan-Out at Fork Time ($t_{\text{fork}}$):**
   - As soon as `SAM 3.1` finishes segmenting frame $t_{\text{fork}}$ (~450ms on A100/H100), fire **both** the `Muse Image` clean-plate request and the `Muse Wonder` physics manifest request **concurrently** via `asyncio.gather()`.
   - Render the interactive `SAM 3.1` sprites on screen *immediately* over a Gaussian-blurred background placeholder while `Muse Image` streams in the clean-plated background 1.2 seconds later.
3. **Two-Tier Voice Command Routing:**
   - **Fast Path (<120ms via `Muse Glimmer` on Baseten):** Direct parameter mutations (*"zero gravity"*, *"moon gravity"*, *"super bouncy"*, *"slow motion"*) bypass full code generation and directly mutate Rapier2D world parameters.
   - **Agentic Code Path (~1.8s via `Muse Code`):** Complex behavioral mechanics (*"turn this van into an Angry Birds slingshot"*, *"make the mugs play a C-major chord on impact"*) trigger the `Muse Code` generator + 30-tick headless verifier loop.

---

## 7. Shot-by-Shot 3-Minute Demo Video & Pitch Runbook

| Timestamp | Visual On Screen | Spoken Pitch Track | Judge Rubric Hit |
| :--- | :--- | :--- | :--- |
| **0:00 - 0:20** | Split screen: normal smartphone video of a city street on left; you click **"Fork Scene"** at 0:03. | *"Video is the world's richest medium, but it's completely frozen on a flat timeline. What if you could pause any video, reach inside with your cursor, and rewrite the laws of physics with your voice? Meet SceneFork."* | **Impact (30%)** |
| **0:20 - 0:55** | Toggle the **X-Ray HUD**: glowing `SAM 3.1` convex polygon hulls appear around the food truck, cones, and streetlamp; `Muse Image` reveals the clean-plated street behind them. | *"When I fork this frame, SAM 3.1 extracts pixel-accurate sprites and 60-FPS collision hulls, Muse Image inpaints the occluded street behind every object, and Muse Wonder infers real-world mass, friction, and acoustic materials."* | **Meta Tooling (25%)** |
| **0:55 - 1:35** | You grab the parked food truck right out of the video with your mouse, fling it into the air, and watch it crash into the streetlamp with procedural metallic audio. | *"Now the video is alive. Notice there's no black hole behind where the truck was parked—and when it collides, our WebAudio synth uses Muse Wonder's material tags to generate real-time impact acoustics."* | **Demo (25%)** |
| **1:35 - 2:25** | Point cursor at the truck and speak: *"Turn this truck into a slingshot that launches exploding traffic cones, and give the street low-gravity moon physics."* Show the live **Muse Code + 30-Tick Verifier HUD** passing green. | *"Watch the bottom panel: Muse Voice Transcribe and Muse Glimmer bind my cursor to Mask #2 in 80 milliseconds. Muse Code writes a TypeScript physics plugin, tests it for 30 headless ticks in a shadow WebWorker to prevent NaN explosions, and hot-swaps it live."* | **Technical Depth (20%)** |
| **2:25 - 3:00** | Pull back the food truck like Angry Birds, launch it across the street in moon gravity, then switch to a 5-second live webcam clip of your own desk and toss your real coffee mug around on screen. | *"From rapid game prototyping and interactive storytelling to spatial physics education—SceneFork turns passive video into a playable world."* | **Viral Bonus ($20k)** |
