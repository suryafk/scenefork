# Demo runbook (Phase 4: record the video)

Judged from a recorded video of about 3 minutes (eng review D13, D20). Rubric weights: Impact 30%, Meta tooling 25%, Technical depth 20%, Demo 25%.

## 1. Shoot the golden clips

You need **3 clips**. Each one is a phone video of a scene with real objects you'll pull out and throw.

| Requirement | Why |
|---|---|
| Landscape, 1080p or 4K, 5-20 s | Frames are fitted to 1280 px; clips over 30 s are refused. |
| Camera still (tripod, or a still stretch at the fork moment) | The fork frame must be sharp: blur makes ragged outlines. |
| 3-6 distinct objects, each 5-40% of the frame width, resting on a visible floor or table | Each object gets its own floor line. Masks wider than 75% of the frame are treated as background and refused. |
| Objects that contrast with what's behind them, plain-ish background around them | The clean background behind each object is painted in by Muse Image; busy backgrounds need more touch-up. |
| Things that sound different (a metal can, a glass bottle, a wooden box, a ball) | The impact sounds come from each object's grounded material. |
| Good, even light, no strong moving shadows | Shadows get included in the removal region only near the object. |

Ideas: a desk (mug, stapler, phone, apple, book), a street corner (bike, bin, cone, sign), a kitchen counter (bottle, kettle, fruit bowl).

Also record **one fresh clip on camera** during the shoot. It is forked live in the video, which proves the pipeline isn't canned (D20).

## 2. Export each golden clip

1. Pick the fork moment and note the time `t` in seconds. Grab that frame as a PNG if OpenCV can't read your phone's HEVC (QuickTime: File → Export As → 1080p, or take a screenshot of the paused frame).
2. Open the frame in Preview, scaled so its long side is 1280 px. Note one click point (x,y) near the middle of each object.
3. Run a free dry run with fake models to check the clicks hit the right objects:

```bash
cd backend && SCENEFORK_ADAPTERS=fake uv run python scripts/export_golden.py --clip-id desk_01 --title "Desk" --video ~/clips/desk.mov --t 2.4 --click 420,380 --click 760,410 --click 1010,450
```

4. Run it live (costs about $0.014 per object: one SAM 3.1 click, one Muse Spark grounding, one Muse Image edit). The script asks before spending, and re-running the same frame and clicks is free from the dev cache:

```bash
cd backend && SCENEFORK_ADAPTERS=live uv run python scripts/export_golden.py --clip-id desk_01 --title "Desk" --video ~/clips/desk.mov --t 2.4 --click 420,380 --click 760,410 --click 1010,450 --copy-video
```

5. Hand-touch the backgrounds (OV9). Open each `frontend/public/golden/<clip>/<fork>/obj_N_patch.webp` in an editor that keeps transparency (Photopea, Pixelmator, GIMP), fix seams or smudges inside the opaque area, and export as WebP (or PNG renamed to the same file name). Don't change the image size.
6. Check it in the app: the clip appears as a ★ button. Free every object, in different orders, at full screen. Nothing should leave a ghost outline.
7. Optional second fork point in the same clip: run again with `--fork-index 1 --t <time>`. "Fork this frame" snaps to the nearest exported point.

Budget for 3 clips with 5 objects each: about **$0.21**, plus a few re-exports if a click misses.

`--ppm` overrides the scale (pixels per meter) when the derived one feels wrong. Objects falling too slowly on screen means ppm is too low (everything acts like it's huge); too fast means it's too high.

## 3. The 3-minute script

| Time | Beat | What's on screen | Say (roughly) |
|---|---|---|---|
| 0:00-0:12 | Hook | Golden clip 1 plays. Pause. Click the most surprising object; it lifts out, you throw it, it clangs. | "What if a video was a world you could reach into?" |
| 0:12-0:40 | Free and throw | Free 2-3 more objects. Throw one into another. Turn X-Ray on (X): hulls, centers of mass, masses. | "One click: SAM 3.1 outlines it, Muse Image paints the background back in, Muse Spark guesses what it weighs and what it's made of." |
| 0:40-1:05 | Presets by voice | Hold Space: "moon gravity", throw something. Point at one object: "make this bouncy". "reset". | "Presets apply instantly. 'This' is whatever I'm pointing at." |
| 1:05-1:50 | Rules become code | Point at an object: "slingshot this". HUD: writing → testing → installed. Drag it back, let go. Then "spin the cones" (or similar). Then "paint it blue": the HUD says why it can't. | "Muse Spark writes a sandboxed plugin plus tests. A shadow physics world checks the tests, including that they fail without the plugin, before it goes live." |
| 1:50-2:30 | Fresh clip, live | Open the clip shot on camera today. Fork, click, free, throw. | "Nothing cached: a clip it has never seen." |
| 2:30-2:50 | How it's safe | X-Ray stats: verifier kills, watchdog restarts; the mutator log. Optional: a broken plugin rejected (see below). | "Plugins run in a locked worker. Infinite loops get killed in 300 ms, a frozen sim restarts from a snapshot." |
| 2:50-3:00 | Close | Architecture diagram + model spend. | "Every Meta model doing a real job: SAM 3.1, Muse Image, Muse Spark." |

Showing a rejected plugin on cue: in a dev build, run this in the browser console. It sends a plugin with an endless loop straight to the verifier:

```js
const s = __sfDebug.physics.latestSnapshot;
__sfDebug.verifier.verify({ snapshot: s, ruleId: 'loop', seed: 1, bindings: { thisId: null, thatId: null, named: [] }, plugin: { feasible: true, reason: '', name: 'loop', summary: '', writes: ['world.gravity'], source: 'return { onInit() { while (true) {} } };', assertions: [{ scenario: { kind: 'init', entity: '', other: '', drag_x_m: 0, drag_y_m: 0, n: 0, rel_speed_mps: 0 }, target: 'world', field: 'gravity_x', cmp: 'gt', value: 1, value_max: 0, at_tick: 0 }] } }).then(console.log);
```

## 4. Recording checklist

- [ ] `SCENEFORK_ADAPTERS=live` and `SPEND_CAP_USD=2` in `backend/.env`; backend and frontend running; the header says "live models".
- [ ] Chrome desktop (voice needs Web Speech); mic permission granted once before recording; sound on.
- [ ] Browser zoom 100%, window 1440x900 or larger, notifications off, bookmarks bar hidden.
- [ ] Rehearse each voice command once live. Repeat takes then replay Muse Spark's answers from the dev cache for free, and the result is identical.
- [ ] The fresh clip take is live by definition (a new frame, so nothing is cached). Budget about $0.05 per attempt.
- [ ] Record every segment twice (a backup take), then cut the best of each.
- [ ] Before the final take: `pnpm --dir frontend e2e` passes, and the evals run at this milestone (OV11, ask before running).
