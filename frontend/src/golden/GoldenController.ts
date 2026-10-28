// Golden clips (eng review OV1): always static and client-side. A click resolves by
// point-in-polygon against the pre-exported objects, so the presenter's exact pixel doesn't
// matter and a free takes one texture upload, not a model call (target: under 300 ms).
import { Texture } from 'pixi.js';
import { trace } from '../debug';
import type { SceneRenderer } from '../render/SceneRenderer';
import type { PhysicsClient } from '../sim/PhysicsClient';
import { pointInPolygon } from '../sim/geometry';
import type { EntityGeometry, Grounding, Point, SceneManifest } from '../sim/types';

type BBox = { x: number; y: number; w: number; h: number };

export interface GoldenObject {
  id: string;
  label: string;
  polygon_px: Point[];
  sprite: string;
  sprite_bbox: BBox;
  patch: string;
  patch_bbox: BBox;
  /** What of the object was visible in the frame (alpha mask); absent in older exports. */
  visible?: string;
  visible_bbox?: BBox;
  plate_method?: string;
  grounding: Grounding;
}

/** shared/golden.schema.json */
export interface GoldenManifest {
  clip_id: string;
  title: string;
  fork_index: number;
  t_fork: number;
  width: number;
  height: number;
  pixels_per_meter: number;
  ground_material: SceneManifest['ground_material'];
  floor_y_px?: number;
  frame: string;
  objects: GoldenObject[];
}

export interface GoldenClip {
  clip_id: string;
  title: string;
  video?: string;
  forks: { fork_index: number; t_fork: number; manifest: string }[];
}

const BASE = `${import.meta.env.BASE_URL}golden/`;
/** A pause this close to a prepared moment uses it; anywhere else forks live with the models. */
export const SNAP_WINDOW_S = 0.5;

async function bitmap(url: string): Promise<ImageBitmap> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return createImageBitmap(await r.blob());
}

/** Reads frontend/public/golden/ (written by backend/scripts/export_golden.py). */
export const StaticGoldenSource = {
  async clips(): Promise<GoldenClip[]> {
    try {
      const r = await fetch(`${BASE}index.json`);
      if (!r.ok) return [];
      return ((await r.json()) as { clips: GoldenClip[] }).clips;
    } catch {
      return [];
    }
  },
  url(path: string): string {
    return BASE + path;
  },
  /** The fork point nearest to a playback time (design step 1: Fork snaps to it). */
  nearestFork(clip: GoldenClip, t: number): GoldenClip['forks'][number] {
    return clip.forks.reduce((best, f) => (Math.abs(f.t_fork - t) < Math.abs(best.t_fork - t) ? f : best));
  },
  /** The prepared fork point to use for a pause at `t`, or null when none is close: fork live. */
  forkFor(clip: GoldenClip, t: number): GoldenClip['forks'][number] | null {
    const f = this.nearestFork(clip, t);
    return Math.abs(f.t_fork - t) <= SNAP_WINDOW_S ? f : null;
  },
};

export interface GoldenEvents {
  toast(text: string): void;
  label(entityId: string, label: string): void;
}

interface Loaded {
  manifest: GoldenManifest;
  frame: ImageBitmap;
  sprites: Map<string, ImageBitmap>;
  patches: Map<string, ImageBitmap>;
  visibles: Map<string, ImageBitmap>;
}

export class GoldenController {
  private loaded: Loaded | null = null;
  private readonly freed = new Set<string>();
  private readonly textures = new Map<string, { texture: Texture; bbox: BBox; z: number }>();
  private generation = 0;
  active = false;

  constructor(
    private readonly renderer: SceneRenderer,
    private readonly physics: PhysicsClient,
    private readonly events: GoldenEvents,
  ) {}

  /** Open one fork point: frame as the plate, every sprite and patch preloaded. */
  async start(manifestPath: string): Promise<GoldenManifest> {
    this.reset();
    const gen = ++this.generation;
    const manifest = (await (await fetch(StaticGoldenSource.url(manifestPath))).json()) as GoldenManifest;
    const dir = StaticGoldenSource.url(manifestPath.replace(/manifest\.json$/, ''));
    const [frame, sprites, patches, visibles] = await Promise.all([
      bitmap(dir + manifest.frame),
      Promise.all(manifest.objects.map(async (o) => [o.id, await bitmap(dir + o.sprite)] as const)),
      Promise.all(manifest.objects.map(async (o) => [o.id, await bitmap(dir + o.patch)] as const)),
      Promise.all(manifest.objects.filter((o) => o.visible).map(async (o) => [o.id, await bitmap(dir + o.visible!)] as const)),
    ]);
    if (gen !== this.generation) throw new Error('superseded');
    this.loaded = { manifest, frame, sprites: new Map(sprites), patches: new Map(patches), visibles: new Map(visibles) };
    this.active = true;
    this.renderer.reset(manifest.width, manifest.height, frame);
    this.physics.load({
      scene_id: `${manifest.clip_id}_${manifest.fork_index}`,
      resolution: { width: manifest.width, height: manifest.height },
      pixels_per_meter: manifest.pixels_per_meter,
      gravity_mps2: 9.81,
      ground_material: manifest.ground_material,
      floor_y_px: manifest.floor_y_px,
      entities: [],
    });
    trace('[golden] start', manifest.clip_id, manifest.fork_index, manifest.objects.length, 'objects', manifest.pixels_per_meter, 'px/m');
    return manifest;
  }

  /** A pointer down that grabbed no body: free the exported object under it, if any. */
  click(x: number, y: number): void {
    if (!this.active || !this.loaded) return;
    // Overlapping outlines (a mug's whole outline runs behind the airplane in front of it): objects
    // are exported front and top first, so the first hit is the one in front.
    const obj = this.loaded.manifest.objects.find((o) => !this.freed.has(o.id) && pointInPolygon([x, y], o.polygon_px));
    if (!obj) {
      this.renderer.pulse(x, y);
      return;
    }
    const t0 = performance.now();
    this.freed.add(obj.id);
    const z = 10 + this.freed.size;
    this.textures.set(obj.id, { texture: Texture.from(this.loaded.sprites.get(obj.id)!), bbox: obj.sprite_bbox, z });
    this.repaint();
    const g = obj.grounding;
    this.physics.add({
      id: obj.id,
      label: obj.label,
      body_type: g.body_type,
      polygon_px: obj.polygon_px,
      physics: { mass_kg: g.mass_kg, restitution: g.restitution, friction: g.friction },
      acoustic_material: g.acoustic_material,
      z_index: z,
    });
    this.events.label(obj.id, obj.label);
    trace('[golden] free', obj.id, obj.label, `${Math.round(performance.now() - t0)} ms`);
  }

  /**
   * The background is the frame plus the freed objects' patches, pasted in export order (each
   * patch shows the scene right after its object's removal), with the visible areas of objects
   * still standing cut out. Same picture whatever order they were clicked in
   * (backend/app/golden.py explains why).
   */
  private repaint(): void {
    const l = this.loaded!;
    const standing = l.manifest.objects.filter((o) => !this.freed.has(o.id) && o.visible_bbox && l.visibles.has(o.id));
    this.renderer.setPlate(l.frame);
    for (const o of l.manifest.objects) {
      if (!this.freed.has(o.id)) continue;
      const b = o.patch_bbox;
      const c = document.createElement('canvas');
      c.width = b.w;
      c.height = b.h;
      const g = c.getContext('2d')!;
      g.drawImage(l.patches.get(o.id)!, 0, 0);
      g.globalCompositeOperation = 'destination-out';
      for (const s of standing) {
        const v = s.visible_bbox!;
        if (v.x < b.x + b.w && v.x + v.w > b.x && v.y < b.y + b.h && v.y + v.h > b.y) g.drawImage(l.visibles.get(s.id)!, v.x - b.x, v.y - b.y);
      }
      this.renderer.pastePatch(c, b);
    }
  }

  added(id: string, geometry: EntityGeometry): void {
    const t = this.textures.get(id);
    if (t) this.renderer.addEntity(geometry, t.texture, t.bbox, t.z);
  }

  get objectCount(): number {
    return this.loaded?.manifest.objects.length ?? 0;
  }

  reset(): void {
    this.generation++;
    this.active = false;
    this.loaded = null;
    this.freed.clear();
    this.textures.clear();
  }
}
