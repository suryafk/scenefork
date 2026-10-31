# Rebuilding the final cut

`marks.json`, `raw_demo.mp4` and `impacts.webm` in `demo-out/` hold the final take. Re-mixing needs no model calls and no ElevenLabs credits.

The two edit settings below are in recording seconds, so they only fit this take. A new recording needs new values.

```bash
cd frontend && DEMO_REMIX=1 DEMO_MUSIC=../demo-out/music_gordian_180.wav DEMO_CUTS="118.3:119.4,122.0:124.2,129.0:129.6" DEMO_CALLOUT="113.2:119.7:121.95:880:60:800:450:The no-op check just rejected a plugin: its tests also passed without it." node scripts/make-demo.mjs
```

Recording from scratch, in order:

1. Start the `frontend` and `backend-live` entries from `.claude/launch.json`.
2. Prime the repaint cache once with `DEMO_STOP=7 node scripts/make-demo.mjs`. Repaints queue at about 20 s each, and the plate sequence only repeats if each one lands before the next free.
3. Run `node scripts/make-demo.mjs`. A take stops early if Muse Voice mishears a command or the slingshot fails, so retry it. Voice transcripts vary between takes, which also keeps the rule generation live.

Voice lines come from one ElevenLabs take split on its pauses (`scripts/import-voice.mjs`), so no API key is needed.
