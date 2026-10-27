// Main-thread side of the verifier: one pre-warmed worker plus a spare (design: Verifier).
// A worker silent for 300 ms after it starts a run is killed, the run fails as "timed out",
// and the spare takes over while a new spare warms up in the background.
import type { VerifyRequest, VerifyResult } from './verifier';
import type { VerifierIn, VerifierOut } from './verifier.worker';

export const SILENCE_KILL_MS = 300;
/** Before a run starts the worker may still be loading Rapier; that isn't the plugin's fault. */
const WARMUP_LIMIT_MS = 10_000;

interface Slot {
  worker: Worker;
  ready: Promise<void>;
}

interface Run {
  id: number;
  resolve(r: VerifyResult): void;
  timer: ReturnType<typeof setTimeout>;
  t0: number;
}

function spawn(): Slot {
  const worker = new Worker(new URL('./verifier.worker.ts', import.meta.url), { type: 'module' });
  const ready = new Promise<void>((resolve) => {
    const onReady = (e: MessageEvent<VerifierOut>) => {
      if (e.data.type !== 'ready') return;
      worker.removeEventListener('message', onReady);
      resolve();
    };
    worker.addEventListener('message', onReady);
  });
  return { worker, ready };
}

export class VerifierClient {
  private active: Slot = spawn();
  private spare: Slot = spawn();
  private seq = 0;
  private run: Run | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** Kills so far (HUD). */
  kills = 0;

  verify(req: VerifyRequest): Promise<VerifyResult> {
    // One run at a time: each request waits for the previous one (and any worker swap).
    const next = this.queue.then(() => this.start(req));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async start(req: VerifyRequest): Promise<VerifyResult> {
    const slot = this.active;
    await slot.ready;
    return new Promise<VerifyResult>((resolve) => {
      const id = ++this.seq;
      const run: Run = { id, resolve, timer: setTimeout(() => this.kill(slot, run, 'never started'), WARMUP_LIMIT_MS), t0: performance.now() };
      this.run = run;
      slot.worker.onmessage = (e: MessageEvent<VerifierOut>) => {
        const m = e.data;
        if (m.type === 'ready' || m.id !== id || this.run !== run) return;
        clearTimeout(run.timer);
        if (m.type === 'result') {
          this.run = null;
          resolve(m.result);
          return;
        }
        run.timer = setTimeout(() => this.kill(slot, run, 'silent'), SILENCE_KILL_MS);
      };
      slot.worker.onerror = (e) => {
        e.preventDefault();
        this.kill(slot, run, e.message || 'crashed');
      };
      slot.worker.postMessage({ type: 'verify', id, req } satisfies VerifierIn);
    });
  }

  private kill(slot: Slot, run: Run, why: string): void {
    if (this.run !== run) return;
    this.run = null;
    clearTimeout(run.timer);
    slot.worker.terminate();
    this.kills++;
    this.active = this.spare;
    this.spare = spawn();
    run.resolve({
      ok: false,
      stage: 'runtime',
      message:
        why === 'silent'
          ? `timed out: a hook ran for over ${SILENCE_KILL_MS} ms without returning (an endless loop?)`
          : `the verifier worker ${why}`,
      results: [],
      ms: Math.round(performance.now() - run.t0),
      logs: [],
    });
  }

  dispose(): void {
    this.active.worker.terminate();
    this.spare.worker.terminate();
  }
}
