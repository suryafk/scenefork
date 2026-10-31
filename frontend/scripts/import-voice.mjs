// Splits one long ElevenLabs take (lines separated by <break> pauses, made through the connector, so
// no API key is needed) into the per-line files make-demo.mjs expects, and registers them in its
// text + voice cache. Lines keep the same performance because they were read in one pass.
//
//   node scripts/import-voice.mjs narration narration.mp3 <voice id>
//   node scripts/import-voice.mjs commands commands.mp3 <voice id>
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(process.env.DEMO_OUT ?? join(here, '../../demo-out'));
const [kind, take, voiceId] = process.argv.slice(2);
const script = JSON.parse(readFileSync(join(here, '../../docs/demo-video/narration.json'), 'utf8'));
// DEMO_ONLY="3,21" imports a patch take holding just those lines (segment numbers, or full names like cmd_raw_sling).
const only = process.env.DEMO_ONLY?.split(',').map((n) => (/^\d+$/.test(n) ? `segment_${n}` : n));
const lines = (
  kind === 'narration'
    ? [...script.segments.map((t, i) => [`segment_${i + 1}`, t]), ...script.xcut.map((t, i) => [`xcut_${i + 1}`, t])]
    : Object.entries(script.commands).map(([k, t]) => [`cmd_raw_${k}`, t])
).filter(([name]) => !only || only.includes(name));

const probe = spawnSync('ffmpeg', ['-hide_banner', '-i', take, '-af', 'silencedetect=noise=-45dB:d=1.1', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
const starts = [...probe.matchAll(/silence_start: ([\d.]+)/g)].map((m) => +m[1]);
const ends = [...probe.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
// Extra cuts, for pauses the model dropped: DEMO_CUTS="0.95:1.75,10.58:10.83" (end of one line : start of the next).
for (const c of (process.env.DEMO_CUTS ?? '').split(',').filter(Boolean)) {
  const [a, b] = c.split(':').map(Number);
  starts.push(a);
  ends.push(b);
}
starts.sort((x, y) => x - y);
ends.sort((x, y) => x - y);
const dur = +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', take]).toString();
if (starts.length !== lines.length - 1) throw new Error(`${starts.length + 1} pieces in the take, ${lines.length} lines in the script`);

const hashFile = join(OUT, 'voice.json');
const hashes = existsSync(hashFile) ? JSON.parse(readFileSync(hashFile, 'utf8')) : {};
lines.forEach(([name, text], i) => {
  const a = Math.max(0, (i ? ends[i - 1] : 0) - 0.03);
  const b = Math.min(dur, (i < starts.length ? starts[i] : dur) + 0.06);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', a.toFixed(3), '-to', b.toFixed(3), '-i', take, '-ar', '44100', '-b:a', '192k', join(OUT, `${name}.mp3`)]);
  hashes[name] = createHash('sha1').update(`el|${voiceId}|${text}`).digest('hex');
  console.log(name, (b - a).toFixed(2), `${(text.length / (b - a)).toFixed(1)} chars/s`, text.slice(0, 40));
});
writeFileSync(hashFile, JSON.stringify(hashes, null, 2));
