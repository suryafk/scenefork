// MutatorAgent eval (eng review D11, OV11). Needs the backend running with live models:
//
//   cd backend && SCENEFORK_ADAPTERS=live uv run uvicorn app.asgi:app --port 8000
//   pnpm --dir frontend eval:mutator -- --runs 5 [--only slingshot] [--max-usd 2]
//
// Each run of a command is a separate sample (its variant number is part of the backend's cache
// key), so re-running the eval replays every sample for free. Results: evals/results/.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syntheticManifest } from '../scene/syntheticScene';
import { SimCore, initRapier } from '../sim/SimCore';
import type { VerifyRequest, VerifyResult } from '../sim/verifier';
import { RuleController, type BuildOutcome, type CodegenReply, type CodegenRequest } from '../voice/RuleController';
import { resolveBindings } from '../voice/router';

interface Case {
  id: string;
  text: string;
  pointer?: string;
  expect: 'install' | 'decline';
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const VERIFY_TIMEOUT_MS = 5000;
const BAR = 0.8;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function verifyInChild(req: VerifyRequest): Promise<VerifyResult> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(HERE, 'verify-child.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ ok: false, stage: 'runtime', message: `timed out: verification ran over ${VERIFY_TIMEOUT_MS} ms (an endless loop?)`, results: [], ms: VERIFY_TIMEOUT_MS, logs: [] });
    }, VERIFY_TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d));
    child.on('close', () => {
      clearTimeout(timer);
      try {
        done(JSON.parse(out) as VerifyResult);
      } catch {
        done({ ok: false, stage: 'runtime', message: 'the verifier process crashed', results: [], ms: 0, logs: [] });
      }
    });
    child.stdin.end(JSON.stringify(req));
  });
}

class Backend {
  private ws!: WebSocket;
  private seq = 0;
  private readonly pending = new Map<string, (r: CodegenReply) => void>();
  live = false;
  spentUsd = 0;

  async connect(url: string): Promise<void> {
    this.ws = new WebSocket(url);
    await new Promise<void>((ok, fail) => {
      this.ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data));
        // The backend sends hello, then the spend total: start once both are in.
        if (m.type === 'hello') this.live = m.live;
        else if (m.type === 'spend') {
          this.spentUsd = m.total_usd;
          ok();
        }
        else if (m.type === 'codegen_result') this.pending.get(m.req_id)?.({ ok: true, plugin: m.plugin, problems: m.problems, ms: m.ms });
        else if (m.type === 'codegen_failed') this.pending.get(m.req_id)?.({ ok: false, reason: m.reason, message: m.message });
      };
      this.ws.onerror = () => fail(new Error(`can't connect to ${url}`));
      this.ws.onclose = (e) => fail(new Error(`backend closed the socket (${e.code})`));
    });
  }

  codegen(req: CodegenRequest): Promise<CodegenReply> {
    const id = `eval${++this.seq}`;
    return new Promise((done) => {
      this.pending.set(id, (r) => {
        this.pending.delete(id);
        done(r);
      });
      this.ws.send(JSON.stringify({ type: 'codegen', req_id: id, ...req }));
    });
  }

  close(): void {
    this.ws.close();
  }
}

const cases = (JSON.parse(readFileSync(join(REPO, 'evals/mutator_cases.json'), 'utf8')) as { cases: Case[] }).cases;
const runs = Number(arg('runs', '5'));
const only = arg('only', '');
const maxUsd = Number(arg('max-usd', '2'));
const url = arg('backend', 'ws://localhost:8000/ws');

await initRapier();
const snapshot = new SimCore(syntheticManifest).snapshot();
const entities = syntheticManifest.entities.map((e) => ({ id: e.id, label: e.label }));
const backend = new Backend();
await backend.connect(url);
if (!backend.live) {
  console.error('The backend is running fake models. Start it with SCENEFORK_ADAPTERS=live.');
  process.exit(2);
}
const spendAtStart = backend.spentUsd;
const t0 = Date.now();

const rows: { case: Case; outcomes: (BuildOutcome & { ms: number })[] }[] = [];
let aborted = '';
outer: for (const c of cases.filter((x) => !only || x.id === only)) {
  const row = { case: c, outcomes: [] as (BuildOutcome & { ms: number })[] };
  rows.push(row);
  for (let run = 1; run <= runs; run++) {
    if (backend.spentUsd - spendAtStart > maxUsd) {
      aborted = `stopped at the $${maxUsd} cap`;
      break outer;
    }
    const controller = new RuleController({
      physics: { loadRule: () => {}, resetRules: () => {}, latestSnapshot: snapshot },
      verify: verifyInChild,
      codegen: (req) => backend.codegen(req),
      log: () => {},
      toast: () => {},
    });
    const bindings = resolveBindings(c.text, entities, c.pointer ? [[c.pointer, 1500]] : []);
    const started = Date.now();
    const out = await controller.build(c.text, bindings, { variant: run });
    row.outcomes.push({ ...out, ms: Date.now() - started });
    const ok = c.expect === 'install' ? out.kind === 'passed' : out.kind !== 'passed';
    console.log(`${ok ? 'PASS' : 'FAIL'} ${c.id} #${run}: ${out.kind} after ${out.attempts} call(s)${out.error ? ` (${out.error.slice(0, 140)})` : ''}`);
  }
}
backend.close();

const passed = (r: (typeof rows)[number]) =>
  r.outcomes.filter((o) => (r.case.expect === 'install' ? o.kind === 'passed' : o.kind !== 'passed')).length;
const spent = backend.spentUsd - spendAtStart;
const lines = [
  `# Mutator eval, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
  '',
  `${runs} runs per command on the demo street; model muse-spark-1.3 (minimal reasoning); bar ${Math.round(BAR * runs)}/${runs}.${aborted ? ` **${aborted}.**` : ''}`,
  '',
  '| Command | Expect | Passed | Calls per run | Right on the first call | Typical failure |',
  '|---|---|---|---|---|---|',
  ...rows.map((r) => {
    const n = r.outcomes.length;
    const calls = r.outcomes.map((o) => o.attempts);
    const ok = (o: BuildOutcome) => (r.case.expect === 'install' ? o.kind === 'passed' : o.kind !== 'passed');
    const first = r.outcomes.filter((o) => ok(o) && o.attempts === 1).length;
    const fail = r.outcomes.find((o) => (r.case.expect === 'install' ? o.kind !== 'passed' : o.kind === 'passed'));
    const verdict = passed(r) >= Math.round(BAR * n) ? '✅' : '❌';
    return `| ${r.case.text} | ${r.case.expect} | ${verdict} ${passed(r)}/${n} | ${calls.join(', ')} | ${first} | ${fail ? (fail.error || fail.kind).replace(/\|/g, '/').slice(0, 120) : ''} |`;
  }),
  '',
  `Overall: ${rows.reduce((s, r) => s + passed(r), 0)}/${rows.reduce((s, r) => s + r.outcomes.length, 0)} runs passed; ${rows.filter((r) => passed(r) >= Math.round(BAR * r.outcomes.length)).length}/${rows.length} commands meet the bar. Model calls: ${rows.reduce((s, r) => s + r.outcomes.reduce((a, o) => a + o.attempts, 0), 0)}. Spend: $${spent.toFixed(4)} (re-runs replay from the dev cache for free). Wall time: ${Math.round((Date.now() - t0) / 1000)} s.`,
];
mkdirSync(join(REPO, 'evals/results'), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
writeFileSync(join(REPO, `evals/results/mutator-${stamp}.json`), JSON.stringify({ runs, spent, aborted, rows }, null, 1));
writeFileSync(join(REPO, 'evals/results/mutator-latest.md'), lines.join('\n') + '\n');
console.log('\n' + lines.join('\n'));
