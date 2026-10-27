// Main-thread handle on the PhysicsWorker: sends scene, entities and pointer input, receives frames.
import type { EntityGeometry, EntitySpec, Grounding, SceneManifest, WorkerToMain } from './types';

type Msg<T extends WorkerToMain['type']> = Extract<WorkerToMain, { type: T }>;

export interface PhysicsHandlers {
  ready(ids: string[], geometry: EntityGeometry[]): void;
  added(id: string, geometry: EntityGeometry): void;
  frame(frame: Msg<'frame'>): void;
  /** Answer to a pointer down: the grabbed entity, or null for a click on the frame itself. */
  grab(grab: Msg<'grab'>): void;
  error(message: string): void;
}

export class PhysicsClient {
  private readonly worker: Worker;
  private seq = 0;

  constructor(private readonly on: PhysicsHandlers) {
    this.worker = new Worker(new URL('./physics.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerToMain>) => {
      const msg = e.data;
      switch (msg.type) {
        case 'ready':
          return this.on.ready(msg.ids, msg.geometry);
        case 'added':
          return this.on.added(msg.id, msg.geometry);
        case 'frame':
          return this.on.frame(msg);
        case 'grab':
          return this.on.grab(msg);
        case 'error':
          return this.on.error(msg.message);
      }
    };
    this.worker.onerror = (e) => this.on.error(e.message || 'physics worker crashed');
  }

  load(manifest: SceneManifest): void {
    this.worker.postMessage({ type: 'init', manifest });
  }

  add(spec: EntitySpec): void {
    this.worker.postMessage({ type: 'add', spec });
  }

  patch(id: string, grounding: Grounding): void {
    this.worker.postMessage({ type: 'patch', id, grounding });
  }

  /** Returns the sequence number the worker's `grab` reply will carry for a pointer down. */
  pointer(phase: 'down' | 'move' | 'up', x: number, y: number): number {
    const seq = ++this.seq;
    this.worker.postMessage({ type: 'pointer', phase, x, y, seq });
    return seq;
  }

  dispose(): void {
    this.worker.terminate();
  }
}
