// Live simulation thread (eng review: plugins and physics never run on the main thread).
// Fixed 60 Hz step on its own timer; posts one transferable frame per tick. This worker is
// the plugin trust boundary: hardenWorker() runs before any plugin can load.
import { hardenWorker } from './harden';
import { DT, SimCore, initRapier } from './SimCore';
import { STRIDE, type CollisionEvent, type MainToWorker, type WorkerToMain } from './types';

const post = hardenWorker<WorkerToMain>();
const MAX_CATCHUP_STEPS = 3;
const SNAPSHOT_EVERY = 30;
let sim: SimCore | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let last = 0;
let acc = 0;
let frames = 0;
/** Rule whose hook start we already reported this tick, so a plugin with onStep posts once. */
let reported: string | null = null;

// A spare worker loads Rapier as soon as it exists, so a restart only rebuilds the world.
const ready = initRapier();

function flushRules(): void {
  if (!sim) return;
  const events = sim.takeRuleEvents();
  const logs = sim.takeLogs();
  if (events.length || logs.length) post({ type: 'rules', active: sim.ruleInfos(), events, logs });
}

function attach(next: SimCore): void {
  sim?.free();
  sim = next;
  sim.onHookEnter = (rule) => {
    if (rule === reported) return;
    reported = rule;
    post({ type: 'running', rule });
  };
  last = performance.now();
  acc = 0;
  frames = 0;
  if (timer === null) timer = setInterval(tick, 1000 / 120);
}

function tick(): void {
  if (!sim) return;
  const now = performance.now();
  acc = Math.min(acc + (now - last) / 1000, DT * MAX_CATCHUP_STEPS);
  last = now;
  const collisions: CollisionEvent[] = [];
  const t0 = performance.now();
  let steps = 0;
  while (acc >= DT) {
    collisions.push(...sim.step());
    acc -= DT;
    steps++;
  }
  if (!steps) return;
  const buf = new Float32Array(sim.ids.length * STRIDE);
  sim.writeFrame(buf);
  reported = null;
  post({ type: 'frame', buf, held: sim.heldId, step_ms: (performance.now() - t0) / steps, collisions }, [buf.buffer]);
  flushRules();
  if (++frames % SNAPSHOT_EVERY === 0) post({ type: 'snapshot', snapshot: sim.snapshot() });
}

self.onmessage = async (e: MessageEvent<MainToWorker>) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      await ready;
      attach(new SimCore(msg.manifest));
      post({ type: 'ready', ids: sim!.ids, geometry: sim!.geometry() });
      post({ type: 'snapshot', snapshot: sim!.snapshot() });
    } else if (msg.type === 'restore') {
      await ready;
      attach(SimCore.restore(msg.snapshot));
      post({ type: 'restored', ids: sim!.ids });
      flushRules();
    } else if (!sim) {
      return;
    } else if (msg.type === 'add') {
      post({ type: 'added', id: msg.spec.id, geometry: sim.addEntity(msg.spec) });
    } else if (msg.type === 'patch') {
      sim.patch(msg.id, msg.grounding);
    } else if (msg.type === 'pointer') {
      if (msg.phase === 'down') post({ type: 'grab', seq: msg.seq, id: sim.grab(msg.x, msg.y), x: msg.x, y: msg.y });
      else if (msg.phase === 'move') sim.drag(msg.x, msg.y);
      else sim.release();
      flushRules();
    } else if (msg.type === 'rule') {
      sim.loadRule(msg.def);
      flushRules();
    } else if (msg.type === 'unload') {
      sim.unloadRule(msg.id);
      flushRules();
    } else if (msg.type === 'reset_rules') {
      sim.resetRules();
      flushRules();
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
