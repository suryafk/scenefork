// Main-thread handle on the PhysicsWorker: sends scene, entities, rules and pointer input,
// receives frames. Also the runtime watchdog (design: Runtime watchdog): no frame for 150 ms
// while the tab is visible means a hook is stuck, so the worker is replaced by a pre-warmed
// spare restored from the latest snapshot (presets kept, plugins dropped).
import type { SimSnapshot } from './SimCore';
import type { RuleDef, RuleEvent, RuleInfo } from './rules';
import type { EntityGeometry, EntitySpec, Grounding, MainToWorker, SceneManifest, WorkerToMain } from './types';

type Msg<T extends WorkerToMain['type']> = Extract<WorkerToMain, { type: T }>;

export const FREEZE_MS = 150;
const WATCH_EVERY_MS = 50;

export interface PhysicsHandlers {
  ready(ids: string[], geometry: EntityGeometry[]): void;
  added(id: string, geometry: EntityGeometry): void;
  frame(frame: Msg<'frame'>): void;
  /** Answer to a pointer down: the grabbed entity, or null for a click on the frame itself. */
  grab(grab: Msg<'grab'>): void;
  rules(active: RuleInfo[], events: RuleEvent[], logs: string[]): void;
  /** The watchdog replaced a frozen worker. `culprit` is the rule whose hook never returned. */
  restarted(culprit: string | null, dropped: RuleInfo[]): void;
  error(message: string): void;
}

function spawn(): Worker {
  return new Worker(new URL('./physics.worker.ts', import.meta.url), { type: 'module' });
}

export class PhysicsClient {
  private worker: Worker;
  private spare: Worker;
  private seq = 0;
  private snapshot: SimSnapshot | null = null;
  /** Messages sent since the last snapshot that a restore must replay (plugins excluded). */
  private sinceSnapshot: MainToWorker[] = [];
  /** Entities re-added by a replay, whose `added` the app has already seen. */
  private readonly replaying = new Set<string>();
  private active: RuleInfo[] = [];
  private running: string | null = null;
  private live = false;
  private lastFrameAt = 0;
  private lastCheckAt = 0;
  private readonly watchdog: ReturnType<typeof setInterval>;
  restarts = 0;

  constructor(private readonly on: PhysicsHandlers) {
    this.worker = this.wire(spawn());
    this.spare = spawn();
    this.lastCheckAt = performance.now();
    this.watchdog = setInterval(() => this.check(), WATCH_EVERY_MS);
  }

  private wire(worker: Worker): Worker {
    worker.onmessage = (e: MessageEvent<WorkerToMain>) => {
      if (worker !== this.worker) return;
      const msg = e.data;
      switch (msg.type) {
        case 'ready':
          this.live = true;
          this.lastFrameAt = performance.now();
          return this.on.ready(msg.ids, msg.geometry);
        case 'restored':
          this.live = true;
          this.lastFrameAt = performance.now();
          return;
        case 'added':
          if (this.replaying.delete(msg.id)) return;
          return this.on.added(msg.id, msg.geometry);
        case 'frame':
          this.lastFrameAt = performance.now();
          this.running = null;
          return this.on.frame(msg);
        case 'grab':
          return this.on.grab(msg);
        case 'rules':
          this.active = msg.active;
          return this.on.rules(msg.active, msg.events, msg.logs);
        case 'snapshot':
          this.snapshot = msg.snapshot;
          this.sinceSnapshot = [];
          return;
        case 'running':
          this.running = msg.rule;
          return;
        case 'error':
          return this.on.error(msg.message);
      }
    };
    worker.onerror = (e) => this.on.error(e.message || 'physics worker crashed');
    return worker;
  }

  private send(msg: MainToWorker): void {
    this.worker.postMessage(msg);
    const replayable = msg.type === 'add' || msg.type === 'patch' || msg.type === 'unload' || msg.type === 'reset_rules' || (msg.type === 'rule' && msg.def.kind === 'preset');
    if (replayable) this.sinceSnapshot.push(msg);
  }

  private check(): void {
    const now = performance.now();
    const gap = now - this.lastCheckAt;
    this.lastCheckAt = now;
    if (!this.live || document.visibilityState !== 'visible') {
      this.lastFrameAt = now;
      return;
    }
    // The main thread itself was busy: queued frames haven't been read yet, so don't judge.
    if (gap > WATCH_EVERY_MS * 2) {
      this.lastFrameAt = Math.max(this.lastFrameAt, now - WATCH_EVERY_MS);
      return;
    }
    if (now - this.lastFrameAt > FREEZE_MS) this.restart();
  }

  private restart(): void {
    if (!this.snapshot) return;
    const culprit = this.running;
    const dropped = this.active.filter((r) => r.kind === 'plugin');
    this.worker.terminate();
    this.worker = this.wire(this.spare);
    this.spare = spawn();
    this.live = false;
    this.running = null;
    this.restarts++;
    this.worker.postMessage({ type: 'restore', snapshot: this.snapshot } satisfies MainToWorker);
    const replay = this.sinceSnapshot;
    this.sinceSnapshot = [];
    for (const m of replay) {
      if (m.type === 'add') this.replaying.add(m.spec.id);
      this.send(m);
    }
    this.active = this.active.filter((r) => r.kind === 'preset');
    this.on.restarted(culprit, dropped);
    this.on.rules(this.active, [], []);
  }

  /** The latest snapshot, for the verifier's shadow world (at most 0.5 s old). */
  get latestSnapshot(): SimSnapshot | null {
    return this.snapshot;
  }

  get rules(): RuleInfo[] {
    return this.active;
  }

  load(manifest: SceneManifest): void {
    this.live = false;
    this.snapshot = null;
    this.sinceSnapshot = [];
    this.active = [];
    this.worker.postMessage({ type: 'init', manifest } satisfies MainToWorker);
  }

  add(spec: EntitySpec): void {
    this.send({ type: 'add', spec });
  }

  patch(id: string, grounding: Grounding): void {
    this.send({ type: 'patch', id, grounding });
  }

  loadRule(def: RuleDef): void {
    this.send({ type: 'rule', def });
  }

  unloadRule(id: string): void {
    this.send({ type: 'unload', id });
  }

  resetRules(): void {
    this.send({ type: 'reset_rules' });
  }

  /** Returns the sequence number the worker's `grab` reply will carry for a pointer down. */
  pointer(phase: 'down' | 'move' | 'up', x: number, y: number): number {
    const seq = ++this.seq;
    this.worker.postMessage({ type: 'pointer', phase, x, y, seq } satisfies MainToWorker);
    return seq;
  }

  dispose(): void {
    clearInterval(this.watchdog);
    this.worker.terminate();
    this.spare.terminate();
  }
}
