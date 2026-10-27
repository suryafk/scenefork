// Live simulation thread (eng review: plugins and physics never run on the main thread).
// Fixed 60 Hz step on its own timer; posts one transferable frame per tick.
import { DT, SimCore, initRapier } from './SimCore';
import { STRIDE, type CollisionEvent, type MainToWorker, type WorkerToMain } from './types';

const ctx = self as unknown as {
  postMessage(message: WorkerToMain, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<MainToWorker>) => void) | null;
};

const MAX_CATCHUP_STEPS = 3;
let sim: SimCore | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let last = 0;
let acc = 0;

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
  ctx.postMessage(
    { type: 'frame', buf, held: sim.heldId, step_ms: (performance.now() - t0) / steps, collisions },
    [buf.buffer],
  );
}

ctx.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      await initRapier();
      sim?.free();
      sim = new SimCore(msg.manifest);
      ctx.postMessage({ type: 'ready', ids: sim.ids, geometry: sim.geometry() });
      last = performance.now();
      acc = 0;
      if (timer === null) timer = setInterval(tick, 1000 / 120);
    } else if (!sim) {
      return;
    } else if (msg.type === 'add') {
      ctx.postMessage({ type: 'added', id: msg.spec.id, geometry: sim.addEntity(msg.spec) });
    } else if (msg.type === 'patch') {
      sim.patch(msg.id, msg.grounding);
    } else if (msg.type === 'pointer') {
      if (msg.phase === 'down') ctx.postMessage({ type: 'grab', seq: msg.seq, id: sim.grab(msg.x, msg.y), x: msg.x, y: msg.y });
      else if (msg.phase === 'move') sim.drag(msg.x, msg.y);
      else sim.release();
    }
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
