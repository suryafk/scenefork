// Main-thread handle on the PhysicsWorker: sends scene and pointer input, receives frames.
import type { EntityGeometry, SceneManifest, WorkerToMain } from './types';

export interface FrameHandler {
  (frame: Extract<WorkerToMain, { type: 'frame' }>): void;
}

export class PhysicsClient {
  private readonly worker: Worker;

  constructor(
    private readonly onReady: (ids: string[], geometry: EntityGeometry[]) => void,
    private readonly onFrame: FrameHandler,
    private readonly onError: (message: string) => void,
  ) {
    this.worker = new Worker(new URL('./physics.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerToMain>) => {
      const msg = e.data;
      if (msg.type === 'ready') this.onReady(msg.ids, msg.geometry);
      else if (msg.type === 'frame') this.onFrame(msg);
      else this.onError(msg.message);
    };
    this.worker.onerror = (e) => this.onError(e.message || 'physics worker crashed');
  }

  load(manifest: SceneManifest): void {
    this.worker.postMessage({ type: 'init', manifest });
  }

  pointer(phase: 'down' | 'move' | 'up', x: number, y: number): void {
    this.worker.postMessage({ type: 'pointer', phase, x, y });
  }

  dispose(): void {
    this.worker.terminate();
  }
}
