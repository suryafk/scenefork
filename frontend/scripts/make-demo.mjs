// Records the SceneFork demo video: voiceover (ElevenLabs, or the macOS `say` placeholder when no
// key is set), a scripted run of the live UI paced to each segment's audio length, the app's own
// impact sounds captured from inside the page, and an ffmpeg mix into one MP4.
//
//   ELEVENLABS_API_KEY=... node scripts/make-demo.mjs        (needs the dev servers on 5173 and 8000)
//
// Output goes to $DEMO_OUT (default ../demo-out): segment_N.mp3, raw_demo.webm, hackathon_demo_viral.mp4.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(process.env.DEMO_OUT ?? join(here, '../../demo-out'));
const URL = process.env.DEMO_URL ?? 'http://localhost:5173/';
const KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? 'TxGEqnHWrfWFTfGW9XjX'; // Josh
const GAP = 0.5; // seconds of breath between segments
const W = 1920;
const H = 1080;
mkdirSync(OUT, { recursive: true });

const narration = JSON.parse(readFileSync(join(here, '../../docs/demo-video/narration.json'), 'utf8')).segments;
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();

// ------------------------------------------------------------------ 1. voiceover
const source = KEY ? 'elevenlabs' : 'say-placeholder';
const marker = join(OUT, 'voice.src');
const stale = !existsSync(marker) || readFileSync(marker, 'utf8') !== source || process.env.FORCE_VOICE;
async function voice() {
  for (let i = 0; i < narration.length; i++) {
    const mp3 = join(OUT, `segment_${i + 1}.mp3`);
    if (!stale && existsSync(mp3)) continue;
    if (KEY) {
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': KEY, 'content-type': 'application/json' },
        body: JSON.stringify({
          text: narration[i],
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true },
        }),
      });
      if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 200)}`);
      writeFileSync(mp3, Buffer.from(await r.arrayBuffer()));
    } else {
      const aiff = join(OUT, `segment_${i + 1}.aiff`);
      sh('say', ['-v', 'Samantha', '-r', '175', '-o', aiff, narration[i]]);
      sh('ffmpeg', ['-y', '-v', 'error', '-i', aiff, '-ar', '44100', '-b:a', '128k', mp3]);
    }
    console.log('voice', i + 1, source);
  }
  writeFileSync(marker, source);
}
await voice();
const dur = narration.map((_, i) => parseFloat(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(OUT, `segment_${i + 1}.mp3`)])));
console.log('segment seconds', dur.map((d) => d.toFixed(1)).join(' '), 'total', (dur.reduce((a, b) => a + b, 0) + GAP * 5).toFixed(0));

// ------------------------------------------------------------------ 2. page helpers injected at load
const INIT = () => {
  // Capture everything the app sends to the speakers so the impact sounds reach the video.
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
  document.addEventListener('DOMContentLoaded', () => {
    const css = document.createElement('style');
    css.textContent = `
      #sf-cursor{position:fixed;z-index:99999;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;
        border:3px solid #ffd54a;background:rgba(255,213,74,.22);pointer-events:none;transition:transform .12s,background .12s;left:-50px;top:-50px}
      #sf-cursor.down{transform:scale(.7);background:rgba(255,213,74,.55)}
      .sf-ripple{position:fixed;z-index:99998;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;border:3px solid #ffd54a;pointer-events:none;animation:sfr .6s ease-out forwards}
      @keyframes sfr{to{transform:scale(4);opacity:0}}
      #sf-cap{position:fixed;z-index:99997;left:50%;bottom:16px;transform:translateX(-50%);max-width:80vw;padding:14px 30px;border-radius:18px;
        background:rgba(8,10,16,.72);color:#fff;font:800 54px/1.15 system-ui,-apple-system,sans-serif;text-align:center;letter-spacing:-.5px;
        opacity:0;transition:opacity .25s;pointer-events:none;text-shadow:0 2px 12px rgba(0,0,0,.6)}
      #sf-cap.on{opacity:1}
      #sf-end{position:fixed;inset:0;z-index:99998;background:radial-gradient(circle at 50% 40%,#16203a,#06080f);color:#fff;display:flex;flex-direction:column;
        align-items:center;justify-content:center;gap:26px;font-family:system-ui,-apple-system,sans-serif;opacity:0;transition:opacity .6s;pointer-events:none}
      #sf-end.on{opacity:1}
      #sf-end h1{font-size:150px;margin:0;letter-spacing:-5px}
      #sf-end p{font-size:46px;margin:0;color:#c9d3ea}
      #sf-end code{font-size:40px;color:#ffd54a}`;
    document.head.append(css);
    const cur = Object.assign(document.createElement('div'), { id: 'sf-cursor' });
    const cap = Object.assign(document.createElement('div'), { id: 'sf-cap' });
    const end = Object.assign(document.createElement('div'), { id: 'sf-end', innerHTML: '<h1>SceneFork</h1><p>Any video becomes something you can touch.</p><code>github.com/suryafk/scenefork</code><p style="font-size:34px">Built solo in 4 days on Meta SAM 3.1, Muse Spark, Muse Image, Muse Voice</p>' });
    document.body.append(cur, cap, end);
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
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'] });
const videoStart = Date.now();
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, recordVideo: { dir: OUT, size: { width: W, height: H } } });
await context.addInitScript(INIT);
const page = await context.newPage();
const video = page.video();

const sleep = (ms) => page.waitForTimeout(ms);
const toScreen = async (x, y) => {
  const b = await page.locator('.canvas-host canvas').boundingBox();
  const s = b.width / 1280;
  return [b.x + x * s, b.y + y * s];
};
async function glide(x, y, steps = 18) {
  await page.mouse.move(x, y, { steps });
}
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
  const per = ms / steps;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
    await sleep(per);
  }
  await sleep(hold);
  await page.mouse.up();
}
const cap = (text) => page.evaluate((t) => { const el = document.getElementById('sf-cap'); el.textContent = t; el.classList.toggle('on', !!t); }, text);
async function say(text) {
  const input = page.getByLabel('Type a physics rule');
  const [bx, by] = await input.boundingBox().then((b) => [b.x + b.width / 2, b.y + b.height / 2]);
  await glide(bx, by);
  await input.click();
  await input.pressSequentially(text, { delay: 60 });
  await sleep(250);
  await page.getByRole('button', { name: 'Apply' }).click();
}
const press = (name) => page.getByRole('button', { name, exact: true }).click();
const bodyOf = (label) => page.evaluate((l) => {
  const s = window.__sfDebug.physics.latestSnapshot;
  const e = s.manifest.entities.find((x) => x.label.toLowerCase().includes(l));
  const b = e && s.bodies.find((x) => x.id === e.id);
  return b ? [b.x * s.manifest.pixels_per_meter, b.y * s.manifest.pixels_per_meter] : null;
}, label);
async function waitFor(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(250);
  }
  return false;
}

const marks = [];
async function segment(i, steps) {
  const d = dur[i];
  const start = Date.now();
  marks.push((start - videoStart) / 1000);
  for (const [at, fn] of steps) {
    const wait = start + at * d * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    await fn();
  }
  const wait = start + (d + GAP) * 1000 - Date.now();
  if (wait > 0) await sleep(wait);
}

await page.goto(URL);
await page.waitForFunction(() => window.__sfDebug !== undefined);
await sleep(800);
// A golden clip needs no model calls to free objects, so the run is free and repeatable.
const clip = page.getByRole('button', { name: /Desk/ });

const obj = { cactus: [218, 324], stapler: [481, 474], mug: [665, 449], phone: [890, 529], holder: [1074, 384] };

await page.addStyleTag({ content: '.app{max-width:1500px;margin:0 auto}' });
const forkBtn = page.getByRole('button', { name: 'Fork this frame' });
// Before the fork the desk video fills exactly the area the playground will take, so the cut is seamless.
await clip.click();
await sleep(400);
const probe = await page.addStyleTag({ content: '.video-panel{display:none}' });
const box = await page.locator('.canvas-host canvas').boundingBox();
await probe.evaluate((e) => e.remove());
const bigVideo = await page.addStyleTag({
  content: `.canvas-host{visibility:hidden}.video-panel > :not(.video-row){visibility:hidden}.fork-btn{opacity:0;position:relative;z-index:60}
    .video-row video{position:fixed!important;left:${box.x}px;top:${box.y}px;width:${box.width}px!important;height:${box.height}px!important;max-width:none!important;max-height:none!important;object-fit:cover;z-index:50;border-radius:8px}`,
});

await segment(0, [
  [0.0, async () => {
    await cap('This is a video.');
    await page.evaluate(() => { const v = document.querySelector('video'); v.muted = true; v.controls = false; v.currentTime = 0; v.playbackRate = 0.5; return v.play(); });
  }],
  [0.14, async () => {
    await cap('Watch me break it.');
    await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 1.5; }); // the prepared fork moment
    await sleep(300);
    await forkBtn.click();
    await sleep(400);
    await bigVideo.evaluate((e) => e.remove());
    await page.addStyleTag({ content: '.video-panel{display:none}' }); // the frame becomes the whole scene
  }],
  [0.3, async () => { await hover(...obj.mug, 350); await tap(...obj.mug); }],
  [0.42, () => cap('Click an object.')],
  [0.54, () => tap(...obj.stapler)],
  [0.66, async () => { await cap('Throw it.'); await drag(obj.mug, [obj.stapler[0] - 30, obj.stapler[1] - 90], { ms: 260, hold: 80 }); }],
  [0.9, () => cap('A video you can touch.')],
]);

if (process.env.DEMO_PROBE) {
  console.log(await page.evaluate(() => ({ t: document.querySelector('video')?.currentTime, trace: window.__sfTrace.filter((l) => /golden|fork|physics/.test(l)).slice(-8) })));
  await page.screenshot({ path: join(OUT, 'probe.png') });
  await context.close();
  await video.saveAs(join(OUT, 'probe.webm'));
  await browser.close();
  process.exit(0);
}

await segment(1, [
  [0.0, () => cap('Every video is frozen.')],
  [0.22, () => cap('SAM 3.1 outlines it from one click')],
  [0.28, () => tap(...obj.phone)],
  [0.4, () => tap(...obj.holder)],
  [0.5, () => cap('Muse Image repaints the background')],
  [0.6, () => tap(...obj.cactus)],
  [0.68, async () => { await cap('Muse Spark guesses weight and material'); await page.getByRole('button', { name: /X-Ray/ }).click(); }],
  [0.9, async () => { await page.getByRole('button', { name: /X-Ray/ }).click(); await cap(''); }],
]);

await segment(2, [
  [0.0, () => cap('Change the laws of physics by talking')],
  [0.02, async () => { await say('zero gravity'); await cap('Zero gravity'); }],
  [0.26, async () => { await press('Jupiter'); await cap('Jupiter'); }],
  [0.4, async () => { await say('moon gravity'); await cap('Moon gravity'); }],
  [0.58, async () => { await press('Earth'); await cap('Earth'); }],
  [0.64, async () => { await hover(...obj.mug, 600); await page.evaluate(() => window.__sfCommand('make this bouncy')); await cap('"Make this bouncy"'); }],
  [0.76, async () => { const p = (await bodyOf('mug')) ?? obj.mug; await drag(p, [p[0], 120], { ms: 500, hold: 100 }); }],
  [0.97, () => cap('')],
]);

await segment(3, [
  [0.0, async () => { await press('reset all').catch(() => {}); await cap('A rule that does not exist yet'); }],
  [0.04, async () => { await say('slingshot the phone'); await cap('"Slingshot the phone"'); }],
  [0.2, async () => {
    await cap('Writing. Testing. Installed.');
    await waitFor(() => page.locator('.mutator-log').innerText().then((t) => /installed/.test(t)).catch(() => false), 40_000);
  }],
  [0.5, async () => { const p = (await bodyOf('phone')) ?? obj.phone; await cap('Drag back. Let go.'); await drag(p, [p[0] - 220, p[1] + 10], { ms: 700, hold: 400 }); }],
  [0.7, async () => { await say('paint it blue'); await cap('"Paint it blue"'); }],
  [0.88, () => cap('The AI proposes. The simulation decides.')],
]);

await segment(4, [
  [0.0, async () => { await cap('Not a mock-up'); await page.getByRole('button', { name: /X-Ray/ }).click(); }],
  [0.08, async () => { await cap('Locked sandbox. No network.'); await say('zero gravity'); }],
  [0.28, async () => { await cap('Infinite loops killed in 300 ms'); await press('Jupiter'); }],
  [0.4, async () => { await cap('Frozen sim restarts from a snapshot'); const p = (await bodyOf('mug')) ?? obj.mug; await drag(p, [p[0] + 120, 110], { ms: 450, hold: 60 }); }],
  [0.54, async () => { await cap('48 of 50 generated rules pass'); const p = (await bodyOf('phone')) ?? obj.phone; await drag(p, [p[0] - 260, p[1] - 160], { ms: 400, hold: 60 }); }],
  [0.68, async () => { await cap('Voice to text in 0.45 s'); await press('Moon'); }],
  [0.82, async () => { await cap('AI suggests rules for what is on screen'); await page.getByRole('button', { name: /X-Ray/ }).click(); }],
]);

await segment(5, [
  [0.0, async () => { await cap(''); await press('Zero-G'); }],
  [0.1, () => page.evaluate(() => document.getElementById('sf-end').classList.add('on'))],
]);
await sleep(1500);

// ------------------------------------------------------------------ 4. collect audio + video
const audioB64 = await page.evaluate(async () => {
  const r = window.__rec;
  if (!r.rec) return null;
  await new Promise((res) => { r.rec.onstop = res; r.rec.stop(); });
  const blob = new Blob(r.chunks, { type: 'audio/webm' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { b64: btoa(s), startedAt: r.startedAt };
});
await context.close();
const rawVideo = join(OUT, 'raw_demo.webm');
await video.saveAs(rawVideo);
await browser.close();
let impactDelay = 0;
if (audioB64) {
  writeFileSync(join(OUT, 'impacts.webm'), Buffer.from(audioB64.b64, 'base64'));
  impactDelay = (audioB64.startedAt - videoStart) / 1000;
}
writeFileSync(join(OUT, 'marks.json'), JSON.stringify({ marks, dur, impactDelay, voice: source }, null, 2));

// ------------------------------------------------------------------ 5. mix
const t0 = Math.max(0, marks[0] - 0.15); // trim the blank frames before the first action
const total = marks[5] + dur[5] + GAP + 1.2 - t0;
const inputs = ['-ss', String(t0), '-i', rawVideo];
const filters = [];
const labels = [];
if (audioB64) {
  inputs.push('-i', join(OUT, 'impacts.webm'));
  const delay = Math.round((impactDelay - t0) * 1000);
  filters.push(delay >= 0 ? `[1:a]adelay=${delay}|${delay},volume=0.8[imp]` : `[1:a]atrim=start=${(-delay / 1000).toFixed(3)},asetpts=PTS-STARTPTS,volume=0.8[imp]`);
  labels.push('[imp]');
}
dur.forEach((_, i) => {
  inputs.push('-i', join(OUT, `segment_${i + 1}.mp3`));
  const idx = i + (audioB64 ? 2 : 1);
  const ms = Math.round((marks[i] - t0) * 1000);
  filters.push(`[${idx}:a]adelay=${ms}|${ms},volume=1.15[v${i}]`);
  labels.push(`[v${i}]`);
});
filters.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0,alimiter=limit=0.95[a]`);
const mp4 = join(OUT, 'hackathon_demo_viral.mp4');
sh('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[a]', '-t', total.toFixed(2),
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-r', '60', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', mp4]);
console.log('done', mp4, `${total.toFixed(0)} s, voice: ${source}`);
