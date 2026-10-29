// WebSocket client for the SceneFork backend (protocol: backend/app/main.py docstring).
import type { PluginDoc } from '../sim/rules';
import type { Grounding, Point } from '../sim/types';
import type { CodegenRequest } from '../voice/RuleController';

export interface FreedEntity {
  id: string;
  label: string;
  polygon_px: Point[];
  sprite_url: string;
  sprite_bbox: { x: number; y: number; w: number; h: number };
  physics: { mass_kg: number; restitution: number; friction: number };
  acoustic_material: Grounding['acoustic_material'];
}

export type ServerMsg =
  | { type: 'hello'; live: boolean; voice?: boolean }
  | { type: 'voice_partial'; req_id: string; text: string }
  | { type: 'voice_final'; req_id: string; text: string; seconds: number }
  | { type: 'voice_failed'; req_id: string; reason: 'unavailable' | 'spend_cap' | 'error'; message: string }
  | { type: 'forked'; req_id: string; fork_id: string; width: number; height: number }
  | { type: 'freed'; req_id: string; fork_id: string; entity: FreedEntity; timing_ms: { segment: number; compile: number } }
  | { type: 'free_failed'; req_id: string; fork_id: string; reason: 'no_object' | 'already_freed' | 'spend_cap' | 'error' | 'cancelled'; message: string }
  | { type: 'grounded'; fork_id: string; entity_id: string; grounding: Grounding }
  | { type: 'plate'; fork_id: string; entity_id: string; version: number; url: string; method: string }
  | { type: 'codegen_result'; req_id: string; attempt: number; plugin: PluginDoc; problems: string[]; ms: number; cached: boolean }
  | { type: 'codegen_failed'; req_id: string; reason: 'spend_cap' | 'error' | 'bad_request'; message: string }
  | { type: 'suggestions'; req_id: string; suggestions: { text: string; kind: 'preset' | 'rule' }[]; cached: boolean }
  | { type: 'spend'; total_usd: number; cap_usd: number }
  | { type: 'error'; code: string; req_id?: string; fork_id?: string };

export type ConnStatus = 'connecting' | 'open' | 'closed' | 'unauthorized';

const KEY_STORAGE = 'scenefork.k';

/** Demo key (eng review D5): read once from the link's `#k=` fragment, then kept for the tab. */
export function demoKey(): string {
  const m = location.hash.match(/[#&]k=([^&]+)/);
  try {
    if (m) {
      sessionStorage.setItem(KEY_STORAGE, decodeURIComponent(m[1]));
      history.replaceState(null, '', location.pathname + location.search);
    }
    return sessionStorage.getItem(KEY_STORAGE) ?? '';
  } catch {
    return m ? decodeURIComponent(m[1]) : '';
  }
}

export class BackendClient {
  private ws: WebSocket | null = null;
  private retryMs = 1000;
  private stopped = false;
  readonly httpBase: string;

  constructor(
    base: string,
    private readonly key: string,
    private readonly onMessage: (m: ServerMsg) => void,
    private readonly onStatus: (s: ConnStatus) => void,
  ) {
    this.httpBase = base.replace(/\/$/, '');
  }

  connect(): void {
    this.stopped = false;
    const url = `${this.httpBase.replace(/^http/, 'ws')}/ws?k=${encodeURIComponent(this.key)}`;
    this.onStatus('connecting');
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 1000;
      this.onStatus('open');
    };
    ws.onmessage = (e) => this.onMessage(JSON.parse(e.data as string) as ServerMsg);
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (e.code === 4401 || e.code === 4403) {
        this.onStatus('unauthorized');
        return;
      }
      this.onStatus('closed');
      if (!this.stopped) {
        setTimeout(() => !this.stopped && this.connect(), this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, 8000);
      }
    };
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  fork(reqId: string, jpeg: Blob, clipHash: string, tFork: number): boolean {
    if (!this.open) return false;
    this.ws!.send(JSON.stringify({ type: 'fork', req_id: reqId, clip_hash: clipHash, t_fork: tFork }));
    this.ws!.send(jpeg);
    return true;
  }

  free(reqId: string, forkId: string, x: number, y: number): boolean {
    if (!this.open) return false;
    this.ws!.send(JSON.stringify({ type: 'free', req_id: reqId, fork_id: forkId, x: Math.round(x), y: Math.round(y) }));
    return true;
  }

  /** One MutatorAgent call (the browser runs the verify/repair loop). */
  codegen(reqId: string, req: CodegenRequest): boolean {
    if (!this.open) return false;
    this.ws!.send(JSON.stringify({ type: 'codegen', req_id: reqId, ...req }));
    return true;
  }

  /** Rule ideas for the freed objects (shown as chips). */
  suggest(reqId: string, entities: unknown[]): boolean {
    if (!this.open) return false;
    this.ws!.send(JSON.stringify({ type: 'suggest', req_id: reqId, entities }));
    return true;
  }

  /** Muse Voice push-to-talk: open a turn, stream PCM frames, end it. */
  voiceStart(reqId: string, keywords: string[]): boolean {
    if (!this.open) return false;
    this.ws!.send(JSON.stringify({ type: 'voice_start', req_id: reqId, keywords }));
    return true;
  }

  voiceAudio(pcm: ArrayBuffer): void {
    if (this.open) this.ws!.send(pcm);
  }

  voiceEnd(reqId: string): void {
    if (this.open) this.ws!.send(JSON.stringify({ type: 'voice_end', req_id: reqId }));
  }

  cancel(reqId: string): void {
    if (this.open) this.ws!.send(JSON.stringify({ type: 'cancel', req_id: reqId }));
  }

  /** Signed asset path from the backend → decoded image (CORS: the backend allows our origin). */
  async image(path: string): Promise<ImageBitmap> {
    const r = await fetch(this.httpBase + path, { mode: 'cors' });
    if (!r.ok) throw new Error(`asset ${r.status}`);
    return createImageBitmap(await r.blob());
  }

  close(): void {
    this.stopped = true;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
