// Click-to-free on a live fork (design: Interaction flow steps 1-8, eng review D9).
// Owns the fork's lifecycle: upload, pre-ack click hold, in-flight rings, freed → body,
// grounding patches, plate swaps, and transparent re-forks after a backend restart.
import { Texture } from 'pixi.js';
import { trace } from '../debug';
import type { BackendClient, FreedEntity, ServerMsg } from '../net/BackendClient';
import type { SceneRenderer } from '../render/SceneRenderer';
import type { PhysicsClient } from '../sim/PhysicsClient';
import type { EntityGeometry, SceneManifest } from '../sim/types';

const MAX_SIDE = 1280;
const MAX_JPEG_BYTES = 1.5 * 1024 * 1024;
const ACK_TIMEOUT_MS = 5000;
const FREE_TIMEOUT_MS = 12_000;
const MAX_IN_FLIGHT = 2;

export interface ForkEvents {
  toast(text: string): void;
  label(entityId: string, label: string): void;
  spend(totalUsd: number, capUsd: number): void;
  lastTiming(ms: number): void;
}

interface Pending {
  x: number;
  y: number;
  ring: string;
  timer: ReturnType<typeof setTimeout>;
}

/** Draw a video frame (or any image) into a canvas at most MAX_SIDE on its long edge. */
export function captureFrame(source: HTMLVideoElement | HTMLCanvasElement, srcW: number, srcH: number): HTMLCanvasElement {
  const s = Math.min(1, MAX_SIDE / Math.max(srcW, srcH));
  const c = document.createElement('canvas');
  c.width = Math.round(srcW * s);
  c.height = Math.round(srcH * s);
  c.getContext('2d')!.drawImage(source, 0, 0, c.width, c.height);
  return c;
}

async function toJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  for (const q of [0.9, 0.8, 0.7, 0.6]) {
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', q));
    if (blob && blob.size <= MAX_JPEG_BYTES) return blob;
  }
  throw new Error('frame too large to upload');
}

export function emptyManifest(width: number, height: number): SceneManifest {
  return { scene_id: 'live_fork', resolution: { width, height }, pixels_per_meter: 100, gravity_mps2: 9.81, ground_material: 'concrete', entities: [] };
}

export class ForkController {
  private forkId: string | null = null;
  private awaitingAck: { req: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private heldClick: { x: number; y: number; ring: string } | null = null;
  private readonly inFlight = new Map<string, Pending>();
  /** Clicks to re-issue once a re-fork (after `unknown_fork`) is acknowledged. */
  private replay: { x: number; y: number; ring: string }[] = [];
  private readonly textures = new Map<string, { texture: Texture; entity: FreedEntity; z: number }>();
  private plateVersion = 0;
  private n = 0;
  private clipHash = '';
  private tFork = 0;
  active = false;

  constructor(
    private readonly renderer: SceneRenderer,
    private readonly physics: PhysicsClient,
    private readonly backend: BackendClient,
    private readonly events: ForkEvents,
  ) {}

  private nextId(prefix: string): string {
    return `${prefix}${++this.n}`;
  }

  /** Step 1-2: freeze this frame, show it, upload it. */
  async start(frame: HTMLCanvasElement, clipHash: string, tFork: number): Promise<void> {
    this.reset();
    this.active = true;
    this.clipHash = clipHash;
    this.tFork = tFork;
    this.renderer.reset(frame.width, frame.height, frame);
    this.physics.load(emptyManifest(frame.width, frame.height));
    await this.upload(frame);
  }

  private async upload(frame: HTMLCanvasElement): Promise<void> {
    const req = this.nextId('fork');
    this.forkId = null;
    this.renderer.setPreparing(true);
    const fail = (text: string) => {
      this.awaitingAck = null;
      this.renderer.setPreparing(false);
      if (this.heldClick) this.renderer.endRing(this.heldClick.ring, true);
      this.heldClick = null;
      this.events.toast(text);
    };
    let jpeg: Blob;
    try {
      jpeg = await toJpeg(frame);
    } catch {
      fail("This frame is too large to upload. Try a smaller video.");
      return;
    }
    if (!this.backend.fork(req, jpeg, this.clipHash, this.tFork)) {
      fail("Can't reach the SceneFork backend. Is it running?");
      return;
    }
    this.awaitingAck = { req, timer: setTimeout(() => fail("Couldn't upload this frame, try again."), ACK_TIMEOUT_MS) };
  }

  /** A pointer down that grabbed nothing: try to free whatever is under it. */
  click(x: number, y: number): void {
    if (!this.active) return;
    const ringHit = this.renderer.ringAt(x, y);
    if (ringHit) {
      // Clicking a pending ring again cancels that free.
      for (const [req, p] of this.inFlight) {
        if (p.ring !== ringHit) continue;
        clearTimeout(p.timer);
        this.inFlight.delete(req);
        this.backend.cancel(req);
      }
      this.renderer.endRing(ringHit, true);
      return;
    }
    if (this.awaitingAck) {
      // D9: hold the first click until the frame is acknowledged; ignore the rest.
      if (this.heldClick) return this.renderer.pulse(x, y);
      const ring = this.nextId('ring');
      this.heldClick = { x, y, ring };
      this.renderer.showRing(ring, x, y);
      return;
    }
    if (!this.forkId) return;
    if (this.inFlight.size >= MAX_IN_FLIGHT) return this.renderer.pulse(x, y);
    const ring = this.nextId('ring');
    this.renderer.showRing(ring, x, y);
    this.send(x, y, ring);
  }

  private send(x: number, y: number, ring: string): void {
    const req = this.nextId('free');
    if (!this.forkId || !this.backend.free(req, this.forkId, x, y)) {
      this.renderer.endRing(ring, true);
      this.events.toast("Can't reach the SceneFork backend.");
      return;
    }
    const timer = setTimeout(() => {
      if (!this.inFlight.delete(req)) return;
      this.renderer.endRing(ring, true);
      this.events.toast("That took too long. Try another spot.");
    }, FREE_TIMEOUT_MS);
    this.inFlight.set(req, { x, y, ring, timer });
  }

  handle(m: ServerMsg): void {
    trace('[fork]', m.type, 'req_id' in m ? m.req_id : '', 'entity_id' in m ? m.entity_id : '',
      m.type === 'grounded' ? m.grounding : m.type === 'plate' ? m.method : m.type === 'freed' ? m.timing_ms : m.type === 'free_failed' ? m.reason : '');
    switch (m.type) {
      case 'spend':
        return this.events.spend(m.total_usd, m.cap_usd);
      case 'forked': {
        if (m.req_id !== this.awaitingAck?.req) return;
        clearTimeout(this.awaitingAck.timer);
        this.awaitingAck = null;
        this.forkId = m.fork_id;
        this.plateVersion = 0; // a re-fork starts its plate versions over
        this.renderer.setPreparing(false);
        const queued = [...(this.heldClick ? [this.heldClick] : []), ...this.replay];
        this.heldClick = null;
        this.replay = [];
        for (const c of queued) this.send(c.x, c.y, c.ring);
        return;
      }
      case 'freed': {
        const p = this.inFlight.get(m.req_id);
        if (p) {
          clearTimeout(p.timer);
          this.inFlight.delete(m.req_id);
          this.renderer.endRing(p.ring, false);
        }
        this.events.lastTiming(m.timing_ms.segment + m.timing_ms.compile);
        this.materialize(m.entity).catch((e) => {
          console.error('freeing failed', m.entity.id, e);
          this.events.toast("Couldn't add that object.");
        });
        return;
      }
      case 'free_failed': {
        const p = this.inFlight.get(m.req_id);
        if (!p) return;
        clearTimeout(p.timer);
        this.inFlight.delete(m.req_id);
        this.renderer.endRing(p.ring, true);
        if (m.reason === 'no_object') this.events.toast("Couldn't grab that, try another spot.");
        else if (m.reason === 'spend_cap') this.events.toast('Model API spend cap reached. Raise SPEND_CAP_USD in backend/.env to keep going.');
        else if (m.reason === 'error') this.events.toast('The model call failed. Try again.');
        return;
      }
      case 'grounded':
        if (!this.textures.has(m.entity_id)) return;
        this.physics.patch(m.entity_id, m.grounding);
        this.events.label(m.entity_id, m.grounding.label);
        return;
      case 'plate':
        if (m.fork_id !== this.forkId || m.version <= this.plateVersion) return;
        this.plateVersion = m.version;
        this.backend
          .image(m.url)
          .then((img) => {
            if (m.version === this.plateVersion) this.renderer.setPlate(img);
          })
          // A newer plate replaced this one server-side before we fetched it: nothing to show.
          .catch(() => undefined);
        return;
      case 'error':
        if (m.code === 'unknown_fork') {
          // The backend restarted or evicted this fork: re-send the current plate (it already
          // has every freed object removed) as a new fork and replay the click.
          const p = m.req_id ? this.inFlight.get(m.req_id) : undefined;
          if (p) {
            clearTimeout(p.timer);
            this.inFlight.delete(m.req_id!);
            this.replay.push({ x: p.x, y: p.y, ring: p.ring });
          }
          if (!this.awaitingAck) void this.upload(this.renderer.plate);
        } else if (m.code === 'frame_too_large' || m.code === 'bad_frame') {
          this.events.toast("The backend couldn't read this frame.");
        }
        return;
      case 'hello':
        return;
    }
  }

  /** Step 5: sprite in, hole blurred, body released with label defaults. */
  private async materialize(entity: FreedEntity): Promise<void> {
    trace('[fork] materialize', entity.id, entity.polygon_px.length, 'vertices');
    let texture: Texture;
    try {
      texture = Texture.from(await this.backend.image(entity.sprite_url));
    } catch {
      this.events.toast("Couldn't load that object's image.");
      return;
    }
    const z = 10 + this.textures.size;
    this.textures.set(entity.id, { texture, entity, z });
    this.renderer.blurHole(entity.polygon_px);
    trace('[fork] add', entity.id);
    this.physics.add({
      id: entity.id,
      label: entity.label,
      body_type: 'dynamic',
      polygon_px: entity.polygon_px,
      physics: entity.physics,
      acoustic_material: entity.acoustic_material,
      z_index: z,
    });
    this.events.label(entity.id, entity.label);
  }

  /** The worker confirmed a body: give it its sprite (same order as the worker's frames). */
  added(id: string, geometry: EntityGeometry): void {
    const t = this.textures.get(id);
    if (t) this.renderer.addEntity(geometry, t.texture, t.entity.sprite_bbox, t.z);
  }

  reset(): void {
    if (this.awaitingAck) clearTimeout(this.awaitingAck.timer);
    for (const p of this.inFlight.values()) clearTimeout(p.timer);
    this.awaitingAck = null;
    this.heldClick = null;
    this.inFlight.clear();
    this.replay = [];
    this.textures.clear();
    this.forkId = null;
    this.plateVersion = 0;
    this.active = false;
    this.renderer.setPreparing(false);
  }
}
