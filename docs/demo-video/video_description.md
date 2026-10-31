# Video description

Paste this under the video. Keep the "How this was made" section: it is what makes the rest of the video trustworthy.

## SceneFork

Pause a video, pull real objects out of the frame, throw them around, and rewrite the laws of physics by voice. New rules are written by Muse Spark as small programs with their own tests, and they must pass in a shadow copy of the world before they can touch the real one.

Built solo in four days for the Meta Global AI Developer Hackathon.

Meta models: SAM 3.1, Muse Spark 1.3, Muse Image 1.0, Muse Voice Transcribe 1.0.

Stack: React, TypeScript, Vite, Pixi v8, Rapier 2D in WASM, Web Workers, Acorn, FastAPI, WebSockets, OpenCV. Tested with Vitest, pytest, Playwright and live evals.

Code (MIT): https://github.com/suryafk/scenefork

## How this was made

- Everything shown as the product is the real app, running the real Meta models. The header reads "live models".
- The narrator is an ElevenLabs synthetic voice (Jonathan). The spoken commands are a second ElevenLabs voice (Jennica), played into the app's real microphone path and transcribed live by Muse Voice. No human is speaking.
- Both clips are AI-generated: the desk clip in the opening, and the table clip that is uploaded and forked (it carries Google's generator watermark and a Google C2PA signature). Neither is phone footage.
- Object frees in this take replay cached model results, as the on-screen note says. Live, each background repaint takes about 20 s. The first live run of this clip was done before this take, and its results are what the cache replays.
- Voice transcription, the slingshot rule, the suggested rule and its repair, and the "paint it blue" refusal were all live model calls in this take.
- The final cut trims waits: about 9 s of black while the table was re-forked, about 4 s of a rule being repaired (the app's own panel still shows the true time, 12.1 s), and most of the silence before each spoken command. "Slow motion" was typed, not spoken.
- The stuck plugin in the safety section is a deliberately looping test plugin sent to the real verifier. It is not model output.
- 48 of 50 is the mutator eval on the demo street scene. 8 of 8 is the grounding eval on the desk clip's objects. Neither was measured on the table clip.
- "Where this goes" is a vision, not shipped features.

## Credits

- Music: "The Gordian Knot" by Jakob Ahlbom, Epidemic Sound (edited to length).
- Voices: ElevenLabs.
- Impact sounds: SceneFork's own procedural audio, generated from each object's material.
