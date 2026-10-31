// Produces the SceneFork demo videos: a 3-minute master and a 45 s cut for X.
//
//   [ELEVENLABS_API_KEY=...] [ELEVENLABS_VOICE_ID=...] [DEMO_MUSIC=track.wav] node scripts/make-demo.mjs
//
// Needs the dev servers on 5173 and 8000 (live models: the upload part forks a real frame).
// What happens: voices come from ElevenLabs, either here with an API key or through the connector
// (scripts/import-voice.mjs registers those lines in the same cache). Playwright drives the real
// app, paced to each narration segment, uploading a clip through the file picker, live-forking it,
// and speaking rules through push-to-talk (the spoken commands are fed to the app as its microphone);
// Chrome's screencast captures the page at up to 60 fps as JPEG frames, which keeps small text sharp;
// the app's own impact sounds are captured from inside the page; ffmpeg overlays the captions and
// mixes voice, sounds and an optional music bed (ducked under the voice), then normalizes loudness.
// No key is ever written to disk.
//
// Output in $DEMO_OUT (default ../demo-out): hackathon_demo_master.mp4, hackathon_demo_x45.mp4,
// plus raw_demo.mp4 / impacts.webm / marks.json, so re-mixing (a new music track) needs no re-record:
//   DEMO_REMIX=1 DEMO_MUSIC=track.wav node scripts/make-demo.mjs
// Take-specific edits, in recording seconds (see docs/demo-video/final_take.md): DEMO_CUTS, DEMO_CALLOUT.
import { chromium } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(process.env.DEMO_OUT ?? join(here, '../../demo-out'));
const URL = process.env.DEMO_URL ?? 'http://localhost:5173/';
const KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? '0F6wBri3KtnolnAMTeIU'; // Jonathan
const CMD_VOICE_ID = process.env.ELEVENLABS_CMD_VOICE_ID ?? 'GrGZY9w6IXhm3DAtiPXT'; // Jennica: the "user" speaking rules
const MUSIC = process.env.DEMO_MUSIC ? resolve(process.env.DEMO_MUSIC) : null;
const CLIP = resolve(process.env.DEMO_CLIP ?? join(here, '../../sample-video/demo-scenefork.mp4')); // uploaded through the file picker
const STOP_AFTER = process.env.DEMO_STOP ? Number(process.env.DEMO_STOP) : null;
const REMIX_ONLY = !!process.env.DEMO_REMIX;
const GAP = 0.13;
const LEAD = 1; // seconds of silence opening each spoken command
const W = 1920;
const H = 1080;
const ZOOM = 1.2; // CSS zoom on the app, so its small UI text reads at laptop size (the page itself stays 1920x1080)
mkdirSync(OUT, { recursive: true });

const script = JSON.parse(readFileSync(join(here, '../../docs/demo-video/narration.json'), 'utf8'));
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).toString();
const probeDur = (f) => parseFloat(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]));

// ------------------------------------------------------------------ 1. voices (cached by text + voice)
const hashes = existsSync(join(OUT, 'voice.json')) ? JSON.parse(readFileSync(join(OUT, 'voice.json'), 'utf8')) : {};
async function tts(text, voiceId, file) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true } }),
  });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 160)}`);
  writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}
async function voiceFile(name, text, voiceId) {
  const file = join(OUT, `${name}.mp3`);
  const el = createHash('sha1').update(`el|${voiceId}|${text}`).digest('hex');
  const h = createHash('sha1').update(`${KEY ? 'el' : 'say'}|${voiceId}|${text}`).digest('hex');
  if (existsSync(file) && (hashes[name] === h || hashes[name] === el)) return file;
  if (KEY) await tts(text, voiceId, file);
  else {
    const aiff = join(OUT, `${name}.aiff`);
    sh('say', ['-v', 'Samantha', '-r', '175', '-o', aiff, text]);
    sh('ffmpeg', ['-y', '-v', 'error', '-i', aiff, '-ar', '44100', '-b:a', '128k', file]);
  }
  hashes[name] = h;
  writeFileSync(join(OUT, 'voice.json'), JSON.stringify(hashes, null, 2));
  console.log('voice', name, KEY ? 'elevenlabs' : 'say-placeholder');
  return file;
}
if (!REMIX_ONLY) {
  for (const [i, t] of script.segments.entries()) await voiceFile(`segment_${i + 1}`, t, VOICE_ID);
  for (const [i, t] of script.xcut.entries()) await voiceFile(`xcut_${i + 1}`, t, VOICE_ID);
  for (const [k, t] of Object.entries(script.commands)) {
    let f;
    try {
      f = await voiceFile(`cmd_raw_${k}`, t, CMD_VOICE_ID);
    } catch (e) {
      console.log('command voice unavailable, using the narrator voice:', e.message.slice(0, 80));
      f = await voiceFile(`cmd_raw_${k}`, t, VOICE_ID);
    }
    // 1 s of lead-in so the capture is open before the first word (0.6 s clipped short commands)
    sh('ffmpeg', ['-y', '-v', 'error', '-i', f, '-af', `adelay=${LEAD * 1000}|${LEAD * 1000},apad=pad_dur=0.25`, join(OUT, `cmd_${k}.mp3`)]);
  }
}
const dur = script.segments.map((_, i) => probeDur(join(OUT, `segment_${i + 1}.mp3`)));
console.log('narration seconds', dur.reduce((a, b) => a + b, 0).toFixed(1));

// ------------------------------------------------------------------ 2. page helpers injected at load
const INIT = () => {
  // (a) Everything the app sends to the speakers is also recorded, so impact sounds reach the video.
  const rec = (window.__rec = { chunks: [], startedAt: 0, rec: null });
  const dests = new WeakMap();
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...a) {
    const r = connect.call(this, dest, ...a);
    try {
      if (dest instanceof AudioDestinationNode) {
        let d = dests.get(this.context);
        if (!d) {
          d = this.context.createMediaStreamDestination();
          dests.set(this.context, d);
          const mr = new MediaRecorder(d.stream, { mimeType: 'audio/webm' });
          mr.ondataavailable = (e) => e.data.size && rec.chunks.push(e.data);
          mr.start(250);
          rec.rec = mr;
          rec.startedAt = Date.now();
        }
        connect.call(this, d);
      }
    } catch {
      /* the page still plays normally */
    }
    return r;
  };
  // (b) The microphone: push-to-talk gets the spoken command named in window.__cmdName.
  const realGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    const b64 = window.__cmds?.[window.__cmdName];
    if (!c?.audio || !b64) return realGUM(c);
    const ctx = new AudioContext();
    const buf = await ctx.decodeAudioData(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)).buffer);
    const dest = ctx.createMediaStreamDestination();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(dest);
    src.start();
    return dest.stream;
  };
  document.addEventListener('DOMContentLoaded', () => {
    const css = document.createElement('style');
    css.textContent = `
      #sf-cursor{position:fixed;z-index:99999;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;
        border:3px solid #ffd54a;background:rgba(255,213,74,.22);pointer-events:none;transition:transform .12s,background .12s;left:-50px;top:-50px}
      #sf-cursor.down{transform:scale(.7);background:rgba(255,213,74,.55)}
      .sf-ripple{position:fixed;z-index:99998;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;border:3px solid #ffd54a;pointer-events:none;animation:sfr .6s ease-out forwards}
      @keyframes sfr{to{transform:scale(4);opacity:0}}
      #sf-cursor.off{opacity:0}
      #sf-tag{position:fixed;z-index:99996;left:640px;top:72px;padding:10px 20px;border-radius:12px;background:#ffd54a;color:#0a0d14;
        font:800 30px/1.15 system-ui,-apple-system,sans-serif;opacity:0;transform:translateY(-8px);transition:opacity .2s,transform .2s;pointer-events:none}
      #sf-tag.on{opacity:1;transform:none}
      #sf-live{position:fixed;z-index:99995;right:252px;top:16px;color:#7cff4d;font:600 22px/1.2 system-ui,-apple-system,sans-serif;pointer-events:none}
      #sf-note{position:fixed;z-index:99996;left:252px;top:154px;max-width:980px;padding:9px 16px;border-radius:10px;background:rgba(8,10,16,.82);color:#fff;
        font:600 25px/1.25 system-ui,-apple-system,sans-serif;opacity:0;transition:opacity .25s;pointer-events:none}
      #sf-note.on{opacity:1}
      .sf-panel{position:fixed;inset:0;z-index:99990;display:flex;flex-direction:column;justify-content:center;gap:26px;padding:0 70px 90px;box-sizing:border-box;
        background:rgba(6,8,15,.86);color:#fff;font-family:system-ui,-apple-system,sans-serif;opacity:0;transition:opacity .35s;pointer-events:none}
      .sf-panel.on{opacity:1}
      .sf-panel h2{font-size:52px;margin:0;letter-spacing:-1px}
      .sf-panel h2 small{display:block;font-size:26px;font-weight:600;color:#ffd54a;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px}
      .sf-step{opacity:0;transform:translateY(12px);transition:opacity .35s,transform .35s}
      .sf-step.on{opacity:1;transform:none}
      #sf-code pre{margin:0;padding:18px 26px;border-radius:14px;background:#10141f;color:#d7e3ff;font:500 22px/1.3 ui-monospace,Menlo,monospace;white-space:pre-wrap;overflow:hidden;max-height:400px}
      #sf-code ul{margin:0;padding:0;list-style:none;display:grid;gap:8px}
      #sf-code li{font:600 22px/1.3 ui-monospace,Menlo,monospace;color:#7cff4d}
      .sf-flow{display:flex;align-items:stretch;gap:14px}
      .sf-box{flex:1;padding:18px 18px;border-radius:14px;background:#141a29;border:2px solid #2c3652;font-size:27px;font-weight:700;line-height:1.2}
      .sf-box small{display:block;margin-top:6px;font-size:22px;font-weight:500;color:#c9d3ea}
      .sf-box.meta{border-color:#ffd54a}
      .sf-box.safe{border-color:#00ffd0}
      .sf-arrow{align-self:center;color:#ffd54a;font-size:34px;font-weight:800}
      .sf-stack{display:flex;flex-wrap:wrap;gap:12px;font-size:24px;color:#c9d3ea}
      .sf-stack b{padding:8px 16px;border-radius:999px;background:#1b2336;font-weight:600}
      .sf-cards{display:grid;grid-template-columns:repeat(2,1fr);gap:20px}
      .sf-card{padding:24px 28px;border-radius:16px;background:#141a29;border:2px solid #2c3652;font-size:32px;line-height:1.25}
      .sf-card b{display:block;margin-bottom:6px;font-size:25px;color:#ffd54a;letter-spacing:1px;text-transform:uppercase}
      .sf-card.wide{grid-column:span 2;border-color:#00ffd0}
      #sf-end{position:fixed;inset:0;z-index:99998;background:radial-gradient(circle at 50% 40%,#16203a,#06080f);color:#fff;display:flex;flex-direction:column;
        align-items:center;justify-content:center;gap:26px;font-family:system-ui,-apple-system,sans-serif;opacity:0;transition:opacity .6s;pointer-events:none}
      #sf-end.on{opacity:1}
      #sf-end h1{font-size:150px;margin:0;letter-spacing:-5px}
      #sf-end p{font-size:46px;margin:0;color:#c9d3ea}
      #sf-end code{font-size:40px;color:#ffd54a}
      #sf-end h1{font-size:130px}
      #sf-fade{position:fixed;inset:0;z-index:100000;background:#000;opacity:0;transition:opacity .35s;pointer-events:none}
      #sf-fade.on{opacity:1}`;
    document.head.append(css);
    const div = (id, html = '', cls = '') => Object.assign(document.createElement('div'), { id, innerHTML: html, className: cls });
    const cur = div('sf-cursor');
    const tag = div('sf-tag');
    const live = div('sf-live');
    const note = div('sf-note');
    // The app's own status line, shown wherever its panel is hidden.
    setInterval(() => { live.textContent = document.querySelector('.conn')?.textContent ?? ''; }, 500);
    const fade = div('sf-fade');
    const code = div('sf-code', '', 'sf-panel');
    const box = (t, s, c = '') => `<div class="sf-box ${c}">${t}<small>${s}</small></div>`;
    const arrow = '<span class="sf-arrow">→</span>';
    const arch = div('sf-arch', `
      <h2><small>Architecture</small>How a spoken rule reaches the scene</h2>
      <div class="sf-flow sf-step">${box('You speak', 'push to talk')}${arrow}${box('Muse Voice', 'speech to text', 'meta')}${arrow}${box('Router', 'preset, under 5 ms')}${arrow}${box('Muse Spark', 'plugin + its own tests', 'meta')}</div>
      <div class="sf-flow sf-step">${box('Shadow world', 'replays every test', 'safe')}${arrow}${box('No-op check', 'same tests without the plugin', 'safe')}${arrow}${box('Up to 2 repairs', 'the failed test goes back', 'safe')}</div>
      <div class="sf-flow sf-step">${box('Sandboxed worker', 'no DOM, no network', 'safe')}${box('300 ms loop kill', 'in the verifier', 'safe')}${box('150 ms watchdog', 'restart from a snapshot', 'safe')}${box('Rule stack', 'removal restores each field', 'safe')}</div>
      <div class="sf-flow sf-step">${box('48 of 50 runs', 'mutator eval, demo street scene')}${box('8 of 8 objects', 'grounding eval')}</div>
      <div class="sf-stack sf-step"><b>SAM 3.1</b><b>Muse Spark 1.3</b><b>Muse Image 1.0</b><b>Muse Voice Transcribe 1.0</b><b>React</b><b>TypeScript</b><b>Vite</b><b>Pixi v8</b><b>Rapier 2D in WASM</b><b>Web Workers</b><b>Acorn</b><b>FastAPI</b><b>WebSockets</b><b>OpenCV</b><b>Vitest</b><b>pytest</b><b>Playwright</b><b>live evals</b></div>`, 'sf-panel');
    const vision = div('sf-vision', `
      <h2><small>Vision, not yet built</small>Where this goes</h2>
      <div class="sf-cards">
        <div class="sf-card sf-step"><b>Learning</b>Film your own world. Change gravity. See the result.</div>
        <div class="sf-card sf-step"><b>Creators</b>A Reel viewers can play with and remix by voice.</div>
        <div class="sf-card sf-step"><b>Games</b>A phone clip becomes a playable prototype, no engine.</div>
        <div class="sf-card sf-step"><b>Why it scales</b>Physics runs on the viewer's device. About $0.014 per freed object, $0.007 per rule attempt.</div>
        <div class="sf-card wide sf-step"><b>Trusted agents</b>The AI proposes, the simulation decides. Code proves itself in a shadow world before it touches a live system.</div>
      </div>`, 'sf-panel');
    const end = div('sf-end', '<h1>SceneFork</h1><p>Any video becomes something you can touch.</p><code>github.com/suryafk/scenefork</code><p style="font-size:34px">Built solo in 4 days on Meta SAM 3.1, Muse Spark, Muse Image, Muse Voice</p>');
    document.body.append(cur, tag, live, note, code, arch, vision, end, fade);
    addEventListener('pointermove', (e) => { cur.style.left = e.clientX + 'px'; cur.style.top = e.clientY + 'px'; }, true);
    addEventListener('pointerdown', (e) => {
      cur.classList.add('down');
      const r = Object.assign(document.createElement('div'), { className: 'sf-ripple' });
      r.style.left = e.clientX + 'px';
      r.style.top = e.clientY + 'px';
      document.body.append(r);
      setTimeout(() => r.remove(), 700);
    }, true);
    addEventListener('pointerup', () => cur.classList.remove('down'), true);
  });
};

// ------------------------------------------------------------------ 3. the run
const marks = [];
const M = {};
const holds = [];
const shown = []; // on-screen quotes of spoken commands, {text, at, end}
let videoStart = Date.now();
let impactDelay = 0;
const rawVideo = join(OUT, 'raw_demo.mp4');

async function record() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'] });
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await context.addInitScript(INIT);
  const page = await context.newPage();

  // Chrome's screencast, not recordVideo: that one is a fixed-bitrate 25 fps stream, too soft for text.
  const framesDir = join(OUT, 'frames');
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir);
  const frames = [];
  const cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', (e) => {
    const f = join(framesDir, `${String(frames.length).padStart(6, '0')}.jpg`);
    writeFileSync(f, Buffer.from(e.data, 'base64'));
    frames.push({ f, t: e.metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {});
  });
  // The plugin Muse Spark sent, read off the app's own WebSocket, so the screen shows the real source.
  let plugin = null;
  const seen = { plate: 0, freed: 0, forked: 0 };
  page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
    try {
      const m = JSON.parse(payload);
      if (m.type === 'codegen_result' && m.plugin?.feasible) plugin = m.plugin;
      if (m.type in seen) seen[m.type]++;
    } catch { /* binary voice frames */ }
  }));

  await page.goto(URL);
  await page.waitForFunction(() => window.__sfDebug !== undefined);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1, maxWidth: W, maxHeight: H });
  videoStart = Date.now();

  const sleep = (ms) => page.waitForTimeout(ms);
  const now = () => (Date.now() - videoStart) / 1000;
  const mk = (n) => (M[n] = now());

  const toScreen = async (x, y) => {
    const b = await page.locator('.canvas-host canvas').boundingBox();
    const s = b.width / 1280;
    return [b.x + x * s, b.y + y * s];
  };
  const glide = (x, y, steps = 18) => page.mouse.move(x, y, { steps });
  async function hover(fx, fy, ms = 500) {
    const [x, y] = await toScreen(fx, fy);
    await glide(x, y);
    await sleep(ms);
  }
  async function tap(fx, fy) {
    const [x, y] = await toScreen(fx, fy);
    await glide(x, y);
    await sleep(120);
    await page.mouse.down();
    await sleep(90);
    await page.mouse.up();
  }
  async function drag(from, to, { steps = 24, hold = 250, ms = 450 } = {}) {
    const [x0, y0] = await toScreen(...from);
    const [x1, y1] = await toScreen(...to);
    await glide(x0, y0);
    await sleep(150);
    await page.mouse.down();
    await sleep(100);
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
      await sleep(ms / steps);
    }
    await sleep(hold);
    await page.mouse.up();
  }
  /** A drag through waypoints, for pulling something up and over what sits next to it. */
  async function dragPath(from, points, { ms = 900, hold = 300 } = {}) {
    const [x0, y0] = await toScreen(...from);
    await glide(x0, y0);
    await sleep(120);
    await page.mouse.down();
    await sleep(80);
    let [px, py] = [x0, y0];
    for (const pt of points) {
      const [x, y] = await toScreen(...pt);
      for (let i = 1; i <= 14; i++) {
        await page.mouse.move(px + ((x - px) * i) / 14, py + ((y - py) * i) / 14);
        await sleep(ms / points.length / 14);
      }
      [px, py] = [x, y];
    }
    await sleep(hold);
    await page.mouse.up();
  }
  const tag = (text) => page.evaluate((t) => { const el = document.getElementById('sf-tag'); if (t) el.textContent = t; el.classList.toggle('on', !!t); }, text);
  const panel = (id, on) => page.evaluate(([i, o]) => { document.getElementById(i).classList.toggle('on', o); document.getElementById('sf-cursor').classList.toggle('off', o); }, [id, on]);
  const note = (text) => page.evaluate((t) => { const el = document.getElementById('sf-note'); if (t) el.textContent = t; el.classList.toggle('on', !!t); }, text);
  const step = (id, n) => page.evaluate(([i, k]) => document.querySelectorAll(`#${i} .sf-step`)[k]?.classList.add('on'), [id, n]);
  const fade = async (on) => { await page.evaluate((o) => document.getElementById('sf-fade').classList.toggle('on', o), on); await sleep(380); };
  /** Zooms the app onto one element (null resets). Canvas coordinates are off while zoomed, so never drag then. */
  const zoom = (sel, s = 1.8) => page.evaluate(([q, k]) => {
    // The parent is transformed, not .app: a transform on the zoomed element would be zoomed too.
    const app = document.querySelector('.app');
    const root = app.parentElement;
    document.getElementById('sf-cursor').classList.toggle('off', !!q);
    root.style.transition = 'transform .45s ease';
    if (!q) { root.style.transform = ''; return; }
    root.style.transition = 'none';
    root.style.transform = '';
    const r = document.querySelector(q).getBoundingClientRect();
    const a = app.getBoundingClientRect();
    const s = document.querySelector('.stage').getBoundingClientRect();
    root.style.transformOrigin = '0 0';
    // The stage must still cover the viewport sides, so no black shows.
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const x = clamp(innerWidth / 2 - (r.left + r.width / 2) * k, innerWidth - s.right * k, -s.left * k);
    const y = clamp(innerHeight * 0.42 - (r.top + r.height / 2) * k, innerHeight - a.bottom * k, -a.top * k);
    root.getBoundingClientRect();
    root.style.transition = 'transform .45s ease';
    root.style.transform = `translate(${x}px,${y}px) scale(${k})`;
  }, [sel, s]);
  const press = (name) => page.getByRole('button', { name, exact: true }).click();
  const xray = () => page.getByRole('button', { name: /X-Ray/ }).click();
  // The upload fork frees objects in this order, so they get these ids (labels stay "object" in the snapshot).
  const LIVE_ID = { mug: 'obj_1', cup: 'obj_2', can: 'obj_3', ball: 'obj_4', box: 'obj_5', phone: 'obj_6' };
  const bodyOf = (name) => page.evaluate((id) => {
    const s = window.__sfDebug.physics.latestSnapshot;
    const b = s.bodies.find((x) => x.id === id);
    return b ? [b.x * s.manifest.pixels_per_meter, b.y * s.manifest.pixels_per_meter] : null;
  }, LIVE_ID[name]);
  async function waitFor(pred, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await pred()) return true;
      await sleep(250);
    }
    return false;
  }
  const hudText = (sel) => page.locator(sel).first().innerText().catch(() => '');
  /** One object at a time, each repaint landed first: the plate sequence, and so the dev cache, then repeats exactly. */
  async function free(at, pause = 200) {
    const { plate, freed } = seen;
    await hover(...at, pause);
    await tap(...at);
    await waitFor(async () => seen.freed > freed && seen.plate > plate, 45000);
  }
  let misheard = null;
  /** Push-to-talk: the named spoken command becomes the microphone while Space is held. */
  async function speak(name) {
    // The app ignores Space while a button has focus, so release focus first.
    await page.evaluate((n) => { window.__cmdName = n; if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); }, name);
    const at = now();
    holds.push({ name, at });
    M[`${name}_hold`] = at;
    const len = probeDur(join(OUT, `cmd_${name}.mp3`));
    shown.push({ text: `“${script.commands[name].replace(/\.$/, '')}”`, at: at + 0.9, end: at + len + 0.4 });
    await page.keyboard.down('Space');
    await sleep(len * 1000 + 500);
    await page.keyboard.up('Space');
    // Muse Voice sometimes doubles a first word or mishears one; a take like that stops here and is redone.
    const plain = (t) => t.toLowerCase().replace(/[^a-z ]/g, '').trim();
    const finals = () => page.evaluate(() => window.__sfTrace.filter((l) => l.startsWith('[voice] final')).at(-1) ?? '');
    const want = plain(script.commands[name]);
    void waitFor(async () => plain((await finals()).replace('[voice] final', '')) === want, 4000).then((ok) => { if (!ok) misheard = name; });
  }
  /** One narration line. Its window is the line plus `tail` seconds. */
  const segment = async (i, steps, tail = 0) => {
    const win = dur[i] + GAP + tail;
    const start = Date.now();
    marks[i] = (start - videoStart) / 1000;
    for (const [at, fn] of steps) {
      // A number is a fraction of the window; ['vo', s] is s seconds after the line has been said.
      const t = Array.isArray(at) ? dur[i] + at[1] : at * win;
      const wait = start + t * 1000 - Date.now();
      if (wait > 0) await sleep(wait);
      await fn();
    }
    const wait = start + win * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    if (misheard) throw new Error(`Muse Voice misheard "${misheard}" in this take`);
    if (STOP_AFTER === i) throw Object.assign(new Error('stop'), { stop: true });
  };
  const bigVideo = async () => {
    const probe = await page.addStyleTag({ content: '.video-panel{display:none}' });
    const box = await page.locator('.canvas-host canvas').boundingBox();
    await probe.evaluate((e) => e.remove());
    const px = (v) => v / ZOOM; // these lengths are inside the zoomed app
    return page.addStyleTag({
      content: `.canvas-host,.voice{visibility:hidden}.video-panel > :not(.video-row){visibility:hidden}.fork-btn{opacity:0;position:relative;z-index:60}
        .video-row video{position:fixed!important;left:${px(box.x)}px;top:${px(box.y)}px;width:${px(box.width)}px!important;height:${px(box.height)}px!important;max-width:none!important;max-height:none!important;object-fit:cover;z-index:50;border-radius:8px}`,
    });
  };

  const cmds = {};
  for (const k of Object.keys(script.commands)) cmds[k] = readFileSync(join(OUT, `cmd_${k}.mp3`)).toString('base64');
  const desk = { cactus: [218, 324], stapler: [481, 474], mug: [665, 449] };
  // Points in the uploaded clip, and the frame the objects are at rest in.
  const obj = { mug: [245, 455], cup: [377, 467], phone: [520, 512], can: [690, 437], box: [907, 477], ball: [1113, 475] };
  const FORK_T = 8.0;

  try {
    await page.evaluate((c) => { window.__cmds = c; }, cmds);
    await sleep(800);
    await page.addStyleTag({ content: `.app{max-width:1200px;margin:0 auto;zoom:${ZOOM}}.toast{display:none!important}.transcript .hint{display:none}` });
    const forkBtn = page.getByRole('button', { name: 'Fork this frame' });

    // ---- Hook: a golden clip plays, freezes, and the near-silence ends when the mug lifts out
    await page.getByRole('button', { name: /Desk/ }).click();
    await sleep(400);
    let hideBig = await bigVideo();
    await segment(0, [
      [0.0, () => page.evaluate(() => { const v = document.querySelector('video'); v.muted = true; v.controls = false; v.currentTime = 0.4; v.playbackRate = 0.7; return v.play(); })],
      [0.4, async () => {
        mk('hookFork');
        await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 1.5; });
        await sleep(250);
        await forkBtn.click();
        await sleep(300);
        await hideBig.evaluate((e) => e.remove());
        hideBig = await page.addStyleTag({ content: '.video-panel{display:none}' });
      }],
      [0.78, async () => { await hover(...desk.mug, 250); mk('lift'); await tap(...desk.mug); }],
    ], 1.8);
    await segment(1, [
      [0.12, () => tap(...desk.stapler)],
      [0.3, async () => { mk('throw'); await drag(desk.mug, [desk.stapler[0] - 30, desk.stapler[1] - 90], { ms: 240, hold: 60 }); }],
      [0.62, () => tap(...desk.cactus)],
    ]);

    // ---- The problem, over objects still in motion
    await segment(2, [
      [0.08, () => press('Moon')],
      [0.3, async () => { await drag(desk.cactus, [980, 200], { ms: 300, hold: 40 }); }],
      [0.75, () => press('Earth')],
    ]);

    // ---- A clip the app has never seen: upload, pause, fork, real model calls
    await segment(3, [
      [0.0, async () => {
        await fade(true);
        await page.getByRole('button', { name: /Leave/ }).click();
        await hideBig.evaluate((e) => e.remove());
        hideBig = await page.addStyleTag({ content: '.canvas-host{visibility:hidden}' });
        await sleep(150);
        await fade(false);
      }],
      [0.1, async () => {
        const bb = await page.locator('label.file').boundingBox();
        await glide(bb.x + bb.width / 2, bb.y + bb.height / 2);
        const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.mouse.down().then(() => sleep(90)).then(() => page.mouse.up())]);
        await fc.setFiles(CLIP);
        await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0);
        await hideBig.evaluate((e) => e.remove());
        hideBig = await bigVideo();
        await page.evaluate(() => { const v = document.querySelector('video'); v.muted = true; v.controls = false; v.currentTime = 0; v.playbackRate = 1.5; return v.play(); });
      }],
      [0.82, async () => {
        await page.evaluate((t) => { const v = document.querySelector('video'); v.pause(); v.currentTime = t; }, FORK_T);
        await sleep(300);
        const n = seen.forked;
        await forkBtn.click();
        await sleep(250);
        await hideBig.evaluate((e) => e.remove());
        hideBig = await page.addStyleTag({ content: '.video-panel{display:none}' });
        await waitFor(async () => seen.forked > n, 15000);
      }],
    ], 0.5);
    await segment(4, [[0.1, async () => { await tag('SAM 3.1: outline from one click'); await free(obj.mug); }]], 0.3);
    await segment(5, [[0.0, async () => {
      await tag('Muse Image: repaints the background');
      await note('This take replays cached model results. Live, each repaint takes about 20 s.');
      await free(obj.cup);
    }]], 0.3);
    await segment(6, [[0.0, async () => { await tag('Muse Spark: mass, material, bounce'); await free(obj.can); }]], 0.3);
    await segment(7, [
      [0.0, async () => { await tag(''); await free(obj.ball); }],
      [0.25, async () => { await free(obj.box); await free(obj.phone); }],
      [0.6, async () => { mk('collide'); const c = (await bodyOf('mug')) ?? obj.mug; const t = (await bodyOf('can')) ?? obj.can; await drag(c, [t[0] - 40, t[1] - 90], { ms: 240, hold: 40 }); }],
      [0.82, async () => { const b = (await bodyOf('ball')) ?? obj.ball; const t = (await bodyOf('box')) ?? obj.box; await drag(b, [t[0] + 10, t[1] - 120], { ms: 220, hold: 40 }); }],
    ], 1.8);
    await segment(8, [
      [0.0, async () => { await note(''); await xray(); }],
      [0.4, async () => { const c = (await bodyOf('can')) ?? obj.can; await drag(c, [c[0] + 240, c[1] - 200], { ms: 280, hold: 40 }); }],
    ], 0.7);

    // ---- Voice: real push-to-talk; narration pauses so each command is heard
    await segment(9, [[0.0, () => xray()], [['vo', 0.1], async () => { await speak('zerog'); mk('zerogDone'); }]], 2.8);
    await segment(10, [[['vo', 0.1], () => speak('jupiter')]], 2.6);
    await segment(11, [
      [0.25, () => press('Moon')],
      [0.36, () => press('Mars')],
      [0.52, async () => { const b = (await bodyOf('ball')) ?? obj.ball; await hover(...b, 200); }],
      [['vo', 0.1], () => speak('bouncy')],
    ], 2.6);
    await segment(12, [
      [0.0, () => press('Earth')],
      [0.08, async () => { const b = (await bodyOf('ball')) ?? obj.ball; await drag(b, [b[0] - 160, 160], { ms: 240, hold: 40 }); }],
      [['vo', 0.3], async () => {
        // Typed, not spoken: the rule box is a feature too, and "slow" clips easily as the first word.
        const box = page.getByLabel('Type a physics rule');
        await box.click();
        await box.pressSequentially('slow motion', { delay: 35 });
        await page.keyboard.press('Enter');
        await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      }],
    ], 1.5);
    await segment(13, [[0.8, () => page.getByRole('button', { name: 'reset all' }).click().catch(() => {})]]);

    // A clean table for the rules, forked again from the same frame. The black is cut from the master.
    await fade(true);
    mk('cutA');
    await page.getByRole('button', { name: /Leave/ }).click();
    await hideBig.evaluate((e) => e.remove());
    await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0);
    hideBig = await bigVideo();
    await page.evaluate((t) => { const v = document.querySelector('video'); v.pause(); v.currentTime = t; }, FORK_T);
    await sleep(400);
    {
      const n = seen.forked;
      await forkBtn.click();
      await sleep(250);
      await hideBig.evaluate((e) => e.remove());
      hideBig = await page.addStyleTag({ content: '.video-panel{display:none}' });
      await waitFor(async () => seen.forked > n, 15000);
    }
    for (const k of ['mug', 'cup', 'can', 'ball', 'box', 'phone']) await free(obj[k], 30);
    await sleep(1200);
    await page.mouse.move(960, 40, { steps: 4 });
    mk('cutB');
    await fade(false);

    // ---- A rule that does not exist yet, written by Muse Spark, tested, installed
    await segment(14, [[['vo', 0.1], () => speak('sling')]], 5.4);
    await segment(15, [
      [0.02, async () => { await tag('Muse Spark: plugin + its own tests'); await zoom('.mutator-log'); }],
      [0.1, async () => {
        await waitFor(async () => /installed|failed/.test(await hudText('.mutator-log li .stage')), 45000);
        if (!/installed/.test(await hudText('.mutator-log li .stage'))) throw new Error(`the slingshot failed its tests in this take:\n${await hudText('.mutator-log li')}`);
        mk('installed');
      }],
    ], 0.3);
    await segment(16, [
      [0.0, async () => {
        if (!/onRelease/.test(plugin?.source ?? '')) throw new Error(`no real slingshot in this take:\n${plugin?.source}`);
        await zoom(null);
        await tag('');
        await page.evaluate((p) => {
          const el = document.getElementById('sf-code');
          const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
          const line = (a) => `✓ ${a.target} ${a.field} ${a.cmp} ${a.value}${a.at_tick ? ` at tick ${a.at_tick}` : ''}`;
          const src = p.source.split('\n');
          const from = Math.max(0, src.findIndex((l) => l.includes('onRelease')));
          const shown = src.slice(from, from + 13).map((l) => l.slice(2)).join('\n');
          el.innerHTML = `<h2><small>Written by Muse Spark, verified in a shadow world</small>${esc(p.name)}</h2><pre>${esc(shown)}</pre><ul>${p.assertions.map((a) => `<li>${esc(line(a))}</li>`).join('')}</ul>`;
        }, plugin);
        await panel('sf-code', true);
      }],
    ], 1.4);
    await segment(17, [
      [0.0, () => panel('sf-code', false)],
      [0.05, async () => {
        const p = (await bodyOf('phone')) ?? obj.phone;
        await dragPath(p, [[p[0], p[1] - 200], [p[0] - 280, p[1] - 180]]);
        mk('launched');
      }],
    ], 1.3);
    await segment(18, [
      [0.03, async () => { await zoom('.suggestions', 1.5); }],
      [0.2, async () => {
        const chip = page.locator('.chip-rule').first();
        await chip.waitFor({ timeout: 15000 });
        await zoom(null);
        await sleep(300);
        await chip.click();
        await sleep(400);
        await waitFor(async () => !/Building rule/.test(await hudText('.transcript')), 30000);
      }],
      [0.42, async () => { const b = (await bodyOf('ball')) ?? obj.ball; const t = (await bodyOf('box')) ?? obj.box; await drag(b, [t[0], t[1] - 130], { ms: 220, hold: 40 }); }],
      [0.62, () => page.locator('.rules button.x').first().click().catch(() => {})],
      [['vo', 0.2], async () => {
        await speak('blue');
        await waitFor(async () => /blue/i.test(await hudText('.mutator-log li')) && !/writing|testing|repairing/.test(await hudText('.mutator-log li .stage')), 15000);
        mk('blueResult');
      }],
    ], 2.8);
    await segment(19, [
      [0.0, () => zoom('.mutator-log', 1.7)],
      [0.86, () => zoom(null)],
    ], 0.3);

    // ---- How it stays safe, built up in step with the narration; a real stuck plugin first
    await segment(20, [
      [0.0, async () => {
        await xray();
        await page.evaluate(() => {
          const s = window.__sfDebug.physics.latestSnapshot;
          window.__sfDebug.verifier.verify({ snapshot: s, ruleId: 'loop', seed: 1, bindings: { thisId: null, thatId: null, named: [] }, plugin: { feasible: true, reason: '', name: 'loop', summary: '', writes: ['world.gravity'], source: 'return { onInit() { while (true) {} } };', assertions: [{ scenario: { kind: 'init', entity: '', other: '', drag_x_m: 0, drag_y_m: 0, n: 0, rel_speed_mps: 0 }, target: 'world', field: 'gravity_x', cmp: 'gt', value: 1, value_max: 0, at_tick: 0 }] } });
        });
      }],
      [0.05, async () => { await tag('A real stuck plugin: 1 verifier kill'); await zoom('.hud-stats', 1.7); }],
      [0.15, async () => { await tag(''); await zoom(null); await panel('sf-arch', true); await step('sf-arch', 0); }],
      [0.28, () => step('sf-arch', 1)],
      [0.56, () => step('sf-arch', 2)],
      [0.68, () => step('sf-arch', 3)],
      [0.84, () => step('sf-arch', 4)],
    ]);

    // ---- Vision, over the scene still moving behind it
    await segment(21, [
      [0.0, async () => { await panel('sf-arch', false); await xray(); await press('Zero-G'); await panel('sf-vision', true); }],
      [0.09, () => step('sf-vision', 0)],
      [0.27, () => step('sf-vision', 1)],
      [0.42, () => step('sf-vision', 2)],
      [0.56, () => step('sf-vision', 4)],
      [0.82, () => step('sf-vision', 3)],
    ]);

    // ---- Close: the app in motion, then the end card
    await segment(22, [
      [0.0, async () => { await panel('sf-vision', false); await press('Jupiter'); }],
      [0.3, async () => { mk('endcard'); await page.evaluate(() => { document.getElementById('sf-end').classList.add('on'); document.getElementById('sf-cursor').classList.add('off'); }); }],
    ], 0.8);
    await sleep(800);
  } catch (e) {
    if (!e.stop) {
      await page.screenshot({ path: join(OUT, 'error_frame.png') }).catch(() => {});
      throw e;
    }
  }

  const stopped = now();
  await cdp.send('Page.stopScreencast');
  const audio = await page.evaluate(async () => {
    const r = window.__rec;
    if (!r.rec) return null;
    await new Promise((res) => { r.rec.onstop = res; r.rec.stop(); });
    const buf = new Uint8Array(await new Blob(r.chunks, { type: 'audio/webm' }).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { b64: btoa(s), startedAt: r.startedAt };
  });
  await page.screenshot({ path: join(OUT, 'last_frame.png') }).catch(() => {});
  writeFileSync(join(OUT, 'take_trace.txt'), `${(await page.evaluate(() => window.__sfTrace)).join('\n')}\n\n${plugin?.source ?? ''}\n`);
  await context.close();
  await browser.close();
  if (audio) {
    writeFileSync(join(OUT, 'impacts.webm'), Buffer.from(audio.b64, 'base64'));
    impactDelay = (audio.startedAt - videoStart) / 1000;
  }
  writeFileSync(join(OUT, 'marks.json'), JSON.stringify({ marks, M, holds, shown, impactDelay }, null, 2));

  // Variable-rate frames become a constant 60 fps master: each frame lasts until the next one arrives.
  const list = ['ffconcat version 1.0'];
  const epoch = videoStart / 1000;
  frames.forEach((fr, i) => {
    const next = frames[i + 1]?.t ?? epoch + stopped;
    list.push(`file '${fr.f}'`, `duration ${Math.max(0.001, next - fr.t).toFixed(4)}`);
  });
  const lead = Math.max(0, frames[0].t - epoch);
  writeFileSync(join(OUT, 'frames.txt'), list.join('\n'));
  console.log('captured', frames.length, 'frames,', (frames.length / stopped).toFixed(1), 'fps average');
  sh('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', join(OUT, 'frames.txt'), '-vf', `tpad=start_duration=${lead.toFixed(3)}:start_mode=clone,fps=60`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-pix_fmt', 'yuv420p', rawVideo]);
  rmSync(framesDir, { recursive: true, force: true });
}

if (REMIX_ONLY) {
  const m = JSON.parse(readFileSync(join(OUT, 'marks.json'), 'utf8'));
  marks.push(...m.marks);
  Object.assign(M, m.M);
  holds.push(...m.holds);
  shown.push(...m.shown);
  impactDelay = m.impactDelay;
} else {
  await record();
}
if (STOP_AFTER !== null) {
  console.log('stopped after segment', STOP_AFTER, 'marks', JSON.stringify(M), 'holds', JSON.stringify(holds));
  process.exit(0);
}

// ------------------------------------------------------------------ 4. captions, mix and both cuts
// Recording time that comes out: the black while the table is re-forked, and any wait for a rule past
// the end of its narration line (the HUD still shows the true time, and the script never says instant).
const cuts = [];
if (M.cutA && M.cutB) cuts.push([M.cutA, M.cutB - 0.25]);
const waitFrom = marks[15] + dur[15] + 0.5;
if (M.installed - 0.6 - waitFrom > 1) cuts.push([waitFrom, M.installed - 0.6]);
// Most of the 1 s of silence before each spoken command: the mic needs it, the viewer doesn't.
for (const h of holds) cuts.push([h.at + 0.12, h.at + 0.87]);
// Take-specific waits to cut, in recording seconds: DEMO_CUTS="118.3:119.4,121.4:124.2"
for (const c of (process.env.DEMO_CUTS ?? '').split(',').filter(Boolean)) cuts.push(c.split(':').map(Number));
cuts.sort((a, b) => a[0] - b[0]);
const edit = (t) => cuts.reduce((out, [a, b]) => (t >= b ? out - (b - a) : t > a ? out - (t - a) : out), t);
const uncut = (t) => cuts.reduce((out, [a, b]) => (out > a ? out + (b - a) : out), t); // edit time back to recording time
const kept = cuts.reduce((acc, [a, b], i) => [...acc.slice(0, i), [acc[i][0], a], [b, Infinity]], [[0, Infinity]]);
const impactEvents = (vol) => kept.map(([a, b]) => {
  const from = Math.max(a, impactDelay);
  return { file: impactsWav, at: edit(from) - marks[0] + 0.15, ss: from - impactDelay, ...(b < Infinity ? { t: b - from } : {}), vol, bus: 'sfx' };
});
marks.forEach((m, i) => { marks[i] = edit(m); });
for (const k of Object.keys(M)) M[k] = edit(M[k]);
holds.forEach((h) => { h.spoken = edit(h.at + LEAD); h.at = edit(h.at); });
shown.forEach((c) => { c.at = edit(c.at); c.end = edit(c.end); });
let source = rawVideo;
if (cuts.length) {
  source = join(OUT, 'raw_cut.mp4');
  const parts = kept.map(([a, b], i) => `[0:v]trim=start=${a.toFixed(3)}${b < Infinity ? `:end=${b.toFixed(3)}` : ''},setpts=PTS-STARTPTS[p${i}]`).join(';');
  const v = `${parts};${kept.map((_, i) => `[p${i}]`).join('')}concat=n=${kept.length}:v=1:a=0[v]`;
  sh('ffmpeg', ['-y', '-v', 'error', '-i', rawVideo, '-filter_complex', v, '-map', '[v]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '14', '-pix_fmt', 'yuv420p', source]);
}

const t0 = Math.max(0, marks[0] - 0.15);
const cmdFile = (n) => join(OUT, `cmd_${n}.mp3`);
const lastSeg = marks.length - 1;
const meanDb = (file, ss = 0) => parseFloat(/mean_volume: (-?[\d.]+)/.exec(spawnSync('ffmpeg', ['-hide_banner', '-ss', String(ss), '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr)[1]);
/** The commands came out of ElevenLabs far quieter than the narrator; they are the feature, so match him. */
const cmdVol = (name) => Math.min(5, 1.15 * 10 ** ((meanDb(join(OUT, 'segment_3.mp3')) - meanDb(cmdFile(name), LEAD)) / 20));

/** A line split into sentences, each timed by its share of the characters. */
function cuesFor(text, at, length) {
  const parts = text.split(/(?<=[.?!])\s+/); // not on the dot in "SAM 3.1"
  const chars = parts.reduce((a, p) => a + p.length, 0);
  let t = at;
  return parts.map((p) => {
    const d = (p.length / chars) * length;
    const cue = { text: p.trim(), at: t, end: t + d };
    t += d;
    return cue;
  });
}

/** Captions become a transparent video, rendered by Chrome (this ffmpeg has no text filters). */
async function captionTrack(cues, total, name) {
  const dir = join(OUT, `caps_${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.setContent(`<style>html,body{margin:0;background:transparent}#c{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);max-width:1560px;width:max-content;padding:10px 26px;border-radius:14px;
    background:rgba(8,10,16,.8);color:#fff;font:700 40px/1.2 system-ui,-apple-system,sans-serif;text-align:center}#c:empty{display:none}</style><div id="c"></div>`);
  const shot = async (text, f) => {
    await page.evaluate((t) => { document.getElementById('c').textContent = t; }, text);
    await page.screenshot({ path: f, omitBackground: true });
  };
  const blank = join(dir, 'blank.png');
  await shot('', blank);
  const sorted = [...cues].sort((a, b) => a.at - b.at);
  const list = ['ffconcat version 1.0'];
  let t = 0;
  for (const [i, c] of sorted.entries()) {
    const at = Math.max(t, c.at);
    const end = Math.min(c.end, sorted[i + 1]?.at ?? total);
    if (end <= at) continue;
    if (at > t) list.push(`file '${blank}'`, `duration ${(at - t).toFixed(3)}`);
    const f = join(dir, `${i}.png`);
    await shot(c.text, f);
    list.push(`file '${f}'`, `duration ${(end - at).toFixed(3)}`);
    t = end;
  }
  list.push(`file '${blank}'`, `duration ${Math.max(0.05, total - t).toFixed(3)}`, `file '${blank}'`);
  await browser.close();
  writeFileSync(join(OUT, `caps_${name}.txt`), list.join('\n'));
  return join(OUT, `caps_${name}.txt`);
}

/** events: {file, at (s in the cut), vol, bus: 'voice' | 'sfx', ss?, t?}; music is ducked under the voice bus. */
function mixAudio(events, total, out, { hush = null, musicFrom = 0, lift = '' } = {}) {
  const args = ['-y', '-v', 'error'];
  const f = [];
  const voice = [];
  const sfx = [];
  events.forEach((e, i) => {
    let { at, ss } = e;
    if (at < 0) { ss = (ss ?? 0) - at; at = 0; }
    if (ss) args.push('-ss', ss.toFixed(3));
    if (e.t) args.push('-t', e.t.toFixed(3));
    args.push('-i', e.file);
    const ms = Math.round(at * 1000);
    // Every input is whole, so number its samples afresh: no container timestamp can then open a hole.
    f.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=N/SR/TB,adelay=${ms}|${ms},volume=${e.vol}[e${i}]`);
    (e.bus === 'voice' ? voice : sfx).push(`[e${i}]`);
  });
  const mix = (labels, name) => (labels.length ? (f.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0[${name}]`), true) : false);
  const hasV = mix(voice, 'vb');
  const hasS = mix(sfx, 'sb');
  const finals = [];
  if (hasS) finals.push('[sb]');
  if (hasV && MUSIC) {
    args.push('-stream_loop', '-1', ...(musicFrom ? ['-ss', String(musicFrom)] : []), '-i', MUSIC);
    // Padded to the full cut: the ducked music stops when its sidechain does.
    f.push(`[vb]apad=whole_dur=${total.toFixed(3)},asplit=2[vb1][vb2]`);
    // The track opens almost silent, so dynaudnorm lifts its quiet stretches: gaps between lines mustn't read as dead air.
    // Near-silence just before the first object lifts out, so the moment lands.
    const dip = hush ? `,volume='if(between(t,${hush[0].toFixed(2)},${hush[1].toFixed(2)}),0.1,1)':eval=frame` : '';
    f.push(`[${events.length}:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=N/SR/TB,dynaudnorm=f=1000:g=41:m=4${lift},volume=0.28${dip},afade=t=in:d=1.5[mus]`);
    f.push(`[mus][vb2]sidechaincompress=threshold=0.015:ratio=10:attack=15:release=500[musd]`);
    finals.push('[vb1]', '[musd]');
  } else if (hasV) finals.push('[vb]');
  f.push(`${finals.join('')}amix=inputs=${finals.length}:normalize=0:dropout_transition=0,loudnorm=I=-16:TP=-2:LRA=11,volume=1.25,alimiter=limit=0.8:level=0,afade=t=out:st=${(total - 0.8).toFixed(2)}:d=0.8,aresample=async=1:first_pts=0[a]`);
  sh('ffmpeg', [...args, '-filter_complex', f.join(';'), '-map', '[a]', '-t', total.toFixed(2), '-ar', '48000', '-c:a', 'aac', '-b:a', '256k', out]);
  assertWholeAudio(out, total);
}
const mux = (video, audio, out) => sh('ffmpeg', ['-y', '-v', 'error', '-i', video, '-i', audio, '-map', '0:v', '-map', '1:a', '-c', 'copy', '-movflags', '+faststart', out]);
const vcodec = ['-c:v', 'libx264', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-crf', '16', '-r', '60'];
const hasImpacts = existsSync(join(OUT, 'impacts.webm'));
// MediaRecorder writes nothing while the app is silent, so the capture has timestamp gaps, and a gap in
// any input makes ffmpeg drop the whole mix for that stretch. Fill them with silence first.
const impactsWav = join(OUT, 'impacts.wav');
if (hasImpacts) sh('ffmpeg', ['-y', '-v', 'error', '-i', join(OUT, 'impacts.webm'), '-af', 'aresample=async=1:first_pts=0', '-ar', '48000', '-ac', '2', impactsWav]);
/** Loudness meters only see what is there, so count the audio itself: a hole must fail the build. */
function assertWholeAudio(file, total) {
  const pts = sh('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file]).trim().split('\n').map((l) => parseFloat(l));
  const seconds = (pts.length * 1024) / 48000;
  const worst = pts.reduce((max, t, i) => (i ? Math.max(max, t - pts[i - 1]) : max), 0);
  if (seconds < total - 0.25 || worst > 0.05) throw new Error(`${file}: ${seconds.toFixed(2)} s of audio for a ${total.toFixed(2)} s cut, largest gap ${worst.toFixed(2)} s`);
}

// -- master (3 minutes)
{
  const total = marks[lastSeg] + dur[lastSeg] + GAP + 0.6 - t0;
  const ev = [];
  if (hasImpacts) ev.push(...impactEvents(1.0));
  dur.forEach((_, i) => ev.push({ file: join(OUT, `segment_${i + 1}.mp3`), at: marks[i] - t0, vol: 1.15, bus: 'voice' }));
  holds.forEach((h) => ev.push({ file: cmdFile(h.name), at: h.spoken - t0, ss: LEAD, vol: cmdVol(h.name), bus: 'voice' }));
  // A hush of under a second before the mug lifts, and a lift through the track's near-silent middle.
  const lift = `,volume='1+1.5*min(max((t-22)/4,0),1)*min(max((64-t)/4,0),1)':eval=frame`;
  mixAudio(ev, total, join(OUT, 'master_audio.m4a'), { hush: [M.lift - t0 - 0.7, M.lift - t0 + 0.1], lift });
  writeFileSync(join(OUT, 'master_events.json'), JSON.stringify(ev.filter((e) => e.bus === 'voice').map(({ file, at, ss }) => ({ file, at, ss })), null, 2));
  const cues = [...script.segments.flatMap((t, i) => cuesFor(t, marks[i] - t0, dur[i])), ...shown.map((c) => ({ ...c, at: c.at - t0, end: c.end - t0 }))];
  // A moment worth reading gets a full-screen crop and a label, in recording seconds:
  // DEMO_CALLOUT="zoomFrom:labelFrom:until:x:y:w:h:label"
  const [ca, cl, cb, cx, cy, cw, ch, ...label] = (process.env.DEMO_CALLOUT ?? '').split(':');
  const from = edit(+ca) - t0;
  const until = edit(+cb) - t0;
  if (ca) cues.push({ text: label.join(':'), at: edit(+cl) - t0, end: until });
  const caps = await captionTrack(cues, total, 'master');
  const callout = ca ? `split[m][z];[z]crop=${cw}:${ch}:${cx}:${cy},scale=${W}:${H}:flags=lanczos[zz];[m][zz]overlay=enable='between(t,${from.toFixed(3)},${until.toFixed(3)})',` : '';
  const vf = `[0:v]${callout}fade=t=in:st=0:d=0.4,fade=t=out:st=${(total - 0.8).toFixed(2)}:d=0.8[b];[1:v]fps=60,format=rgba[c];[b][c]overlay=format=auto:shortest=1[v]`;
  sh('ffmpeg', ['-y', '-v', 'error', '-ss', t0.toFixed(2), '-t', total.toFixed(2), '-i', source, '-f', 'concat', '-safe', '0', '-i', caps, '-filter_complex', vf, '-map', '[v]', ...vcodec, '-an', join(OUT, 'master_video.mp4')]);
  mux(join(OUT, 'master_video.mp4'), join(OUT, 'master_audio.m4a'), join(OUT, 'hackathon_demo_master.mp4'));
  console.log('master', total.toFixed(1), 's', MUSIC ? 'with music' : 'no music');
}

// -- 45 s cut for X: ranges from the same recording, each opened by its own short narration line
{
  const E = (n) => M[n] ?? 0;
  const ranges = [
    { a: E('hookFork') - 0.6, b: E('throw') + 2.6, vo: 0 },
    { a: E('zerog_hold') + 0.6, b: E('zerog_hold') + 6, vo: 1 },
    { a: E('sling_hold') - 0.4, b: E('sling_hold') + 5.2, vo: 2 },
    { a: E('installed') - 1.4, b: E('launched') + 2.4, vo: null },
    { a: E('blue_hold') + 0.6, b: E('blueResult') + 2.6, vo: 3 },
    { a: E('endcard') - 0.2, b: E('endcard') + 5.8, vo: 4 },
  ].filter((r) => r.b > r.a);
  let cursor = 0;
  const starts = [];
  ranges.forEach((r) => { starts.push(cursor); cursor += r.b - r.a; });
  const total = cursor;
  const ev = [];
  const cues = [];
  ranges.forEach((r, i) => {
    if (hasImpacts) ev.push({ file: impactsWav, at: starts[i], ss: uncut(r.a) - impactDelay, t: r.b - r.a, vol: 1.0, bus: 'sfx' });
    if (r.vo !== null) {
      const file = join(OUT, `xcut_${r.vo + 1}.mp3`);
      ev.push({ file, at: starts[i] + 0.15, vol: 1.15, bus: 'voice' });
      cues.push(...cuesFor(script.xcut[r.vo], starts[i] + 0.15, probeDur(file)));
    }
    // The short narration lines quote each command, so playing it too would talk over them.
    if (r.vo === null) holds.forEach((h) => { if (h.at >= r.a - 0.1 && h.at <= r.b) ev.push({ file: cmdFile(h.name), at: starts[i] + (h.at - r.a), vol: cmdVol(h.name), bus: 'voice' }); });
  });
  const caps = await captionTrack(cues, total, 'x45');
  const vf = ranges.map((r, i) => `[0:v]trim=start=${r.a.toFixed(3)}:end=${r.b.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`).join(';');
  const cat = `${ranges.map((_, i) => `[v${i}]`).join('')}concat=n=${ranges.length}:v=1:a=0,fade=t=in:st=0:d=0.3,fade=t=out:st=${(total - 0.7).toFixed(2)}:d=0.7[b];[1:v]fps=60,format=rgba[c];[b][c]overlay=format=auto:shortest=1[v]`;
  sh('ffmpeg', ['-y', '-v', 'error', '-i', source, '-f', 'concat', '-safe', '0', '-i', caps, '-filter_complex', `${vf};${cat}`, '-map', '[v]', ...vcodec, '-an', join(OUT, 'x45_video.mp4')]);
  mixAudio(ev, total, join(OUT, 'x45_audio.m4a'), { musicFrom: 95 }); // the track's build, not its quiet opening
  mux(join(OUT, 'x45_video.mp4'), join(OUT, 'x45_audio.m4a'), join(OUT, 'hackathon_demo_x45.mp4'));
  console.log('x45', total.toFixed(1), 's');
}
