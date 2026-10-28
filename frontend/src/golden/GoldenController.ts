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
};

export interface GoldenEvents {
  toast(text: string): void;
  label(entityId: string, label: string): void;
}

interface Loaded {
  manifest: GoldenManifest;
  sprites: Map<string, ImageBitmap>;
  patches: Map<string, ImageBitmap>;
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
    const [frame, sprites, patches] = await Promise.all([
      bitmap(dir + manifest.frame),
      Promise.all(manifest.objects.map(async (o) => [o.id, await bitmap(dir + o.sprite)] as const)),
      Promise.all(manifest.objects.map(async (o) => [o.id, await bitmap(dir + o.patch)] as const)),
    ]);
    if (gen !== this.generation) throw new Error('superseded');
    this.loaded = { manifest, sprites: new Map(sprites), patches: new Map(patches) };
    this.active = true;
    this.renderer.reset(manifest.width, manifest.height, frame);
    this.physics.load({
      scene_id: `${manifest.clip_id}_${manifest.fork_index}`,
      resolution: { width: manifest.width, height: manifest.height },
      pixels_per_meter: manifest.pixels_per_meter,
      gravity_mps2: 9.81,
      ground_material: manifest.ground_material,
      entities: [],
    });
    trace('[golden] start', manifest.clip_id, manifest.fork_index, manifest.objects.length, 'objects', manifest.pixels_per_meter, 'px/m');
    return manifest;
  }

  /** A pointer down that grabbed no body: free the exported object under it, if any. */
  click(x: number, y: number): void {
    if (!this.active || !this.loaded) return;
    const hit = this.loaded.manifest.objects.filter((o) => !this.freed.has(o.id) && pointInPolygon([x, y], o.polygon_px));
    // Overlapping outlines: the smaller one is the object in front.
    const obj = hit.sort((a, b) => a.sprite_bbox.w * a.sprite_bbox.h - b.sprite_bbox.w * b.sprite_bbox.h)[0];
    if (!obj) {
      this.renderer.pulse(x, y);
      return;
    }
    const t0 = performance.now();
    this.freed.add(obj.id);
    const z = 10 + this.freed.size;
    this.textures.set(obj.id, { texture: Texture.from(this.loaded.sprites.get(obj.id)!), bbox: obj.sprite_bbox, z });
    this.renderer.pastePatch(this.loaded.patches.get(obj.id)!, obj.patch_bbox);
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
