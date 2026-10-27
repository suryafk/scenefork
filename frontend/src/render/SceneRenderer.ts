// Pixi v8 view of the simulation: the clean plate, entity sprites anchored on their centroids,
// click-to-free feedback (rings, blurred holes) and the X-Ray overlay. It renders whatever
// the latest worker frame says; it never simulates.
import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
import { boundingBox, spriteAnchor } from '../sim/geometry';
import { FLAG_FLOOR_ACTIVE, FLAG_HELD, STRIDE, type EntityGeometry, type Point, type SceneManifest } from '../sim/types';
import { paintSprite } from '../scene/syntheticScene';

const XRAY = {
  hull: 0x00ffd0,
  hullFixed: 0xffd54f,
  centroid: 0xff3b81,
  velocity: 0x7cff4d,
  floorOn: 0x4dd0ff,
  floorOff: 0x35505e,
};
/** Velocity arrows: pixels drawn per (pixel/second). */
const VEL_SCALE = 0.12;

interface Ring {
  x: number;
  y: number;
  born: number;
  /** Set when the request ends: the ring shrinks and fades instead of vanishing. */
  ended?: number;
  failed?: boolean;
}

export class SceneRenderer {
  readonly app = new Application();
  private readonly layer = new Container({ sortableChildren: true });
  private readonly xray = new Graphics();
  private readonly overlay = new Graphics();
  private plateCanvas = document.createElement('canvas');
  private plateTexture: Texture | null = null;
  private readonly plateSprite = new Sprite();
  private sprites: Sprite[] = [];
  private geometry: EntityGeometry[] = [];
  private frame: Float32Array | null = null;
  private readonly rings = new Map<string, Ring>();
  private pulses: Ring[] = [];
  private preparing = false;
  xrayOn = false;

  async init(host: HTMLElement, width: number, height: number): Promise<void> {
    await this.app.init({ width, height, background: '#101418', antialias: true, autoDensity: true, resolution: window.devicePixelRatio });
    const canvas = this.app.canvas;
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    canvas.style.display = 'block';
    canvas.style.touchAction = 'none';
    host.appendChild(canvas);
    this.plateSprite.zIndex = -1000;
    this.xray.zIndex = 10_000;
    this.overlay.zIndex = 10_001;
    this.layer.addChild(this.plateSprite, this.xray, this.overlay);
    this.app.stage.addChild(this.layer);
    this.app.ticker.add(() => this.render());
  }

  /** Start a new scene: resize to the frame, show the plate, drop every entity. */
  reset(width: number, height: number, plate: CanvasImageSource): void {
    if (this.app.screen.width !== width || this.app.screen.height !== height) this.app.renderer.resize(width, height);
    for (const s of this.sprites) s.destroy({ texture: true });
    this.sprites = [];
    this.geometry = [];
    this.frame = null;
    this.rings.clear();
    this.pulses = [];
    this.setPlate(plate);
  }

  /** Replace the background (the clean plate) with a new image of the same size. */
  setPlate(image: CanvasImageSource): void {
    const { width, height } = this.app.screen;
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    c.getContext('2d')!.drawImage(image, 0, 0, width, height);
    this.plateCanvas = c;
    const old = this.plateTexture;
    this.plateTexture = Texture.from(c);
    this.plateSprite.texture = this.plateTexture;
    old?.destroy(true);
  }

  /** The current plate, for re-sending after a backend restart (it has freed objects removed). */
  get plate(): HTMLCanvasElement {
    return this.plateCanvas;
  }

  /**
   * Smear the hole a freed object leaves until the clean plate arrives (design step 6):
   * the region, blurred hard, so the object doesn't appear twice.
   */
  blurHole(polygon: Point[]): void {
    const { width, height } = this.plateCanvas;
    const path = new Path2D();
    polygon.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
    path.closePath();
    // Blurred copy of the plate, cut to the outline dilated by 12px (fill + 24px-wide stroke).
    const patch = document.createElement('canvas');
    patch.width = width;
    patch.height = height;
    const p = patch.getContext('2d')!;
    p.filter = 'blur(22px) saturate(0.6)';
    p.drawImage(this.plateCanvas, 0, 0);
    p.filter = 'none';
    p.globalCompositeOperation = 'destination-in';
    p.fillStyle = '#fff';
    p.strokeStyle = '#fff';
    p.lineWidth = 24;
    p.lineJoin = 'round';
    p.fill(path);
    p.stroke(path);
    this.plateCanvas.getContext('2d')!.drawImage(patch, 0, 0);
    this.plateTexture?.source.update();
  }

  /** Synthetic scene: entity sprites painted locally from the manifest. */
  setScene(manifest: SceneManifest, ids: string[], geometry: EntityGeometry[]): void {
    ids.forEach((id, i) => {
      const spec = manifest.entities.find((e) => e.id === id)!;
      const bbox = boundingBox(spec.polygon_px);
      this.addEntity(geometry[i], Texture.from(paintSprite(spec, bbox)), bbox, spec.z_index);
    });
  }

  /** Add one entity's sprite; its index must match the worker's frame order. */
  addEntity(geo: EntityGeometry, texture: Texture, bbox: { x: number; y: number; w: number; h: number }, z: number): void {
    const sprite = new Sprite(texture);
    const [ax, ay] = spriteAnchor(geo.centroid_px, bbox);
    sprite.anchor.set(ax, ay);
    sprite.position.set(geo.centroid_px[0], geo.centroid_px[1]);
    sprite.zIndex = z;
    this.layer.addChild(sprite);
    this.sprites.push(sprite);
    this.geometry.push(geo);
  }

  pushFrame(buf: Float32Array): void {
    this.frame = buf;
  }

  setPreparing(on: boolean): void {
    this.preparing = on;
  }

  showRing(key: string, x: number, y: number): void {
    this.rings.set(key, { x, y, born: performance.now() });
  }

  endRing(key: string, failed: boolean): void {
    const r = this.rings.get(key);
    if (r && r.ended === undefined) {
      r.ended = performance.now();
      r.failed = failed;
    }
  }

  ringAt(x: number, y: number, radius = 26): string | null {
    for (const [key, r] of this.rings) if (r.ended === undefined && Math.hypot(r.x - x, r.y - y) < radius) return key;
    return null;
  }

  /** A brief "busy" pulse where a click was ignored. */
  pulse(x: number, y: number): void {
    this.pulses.push({ x, y, born: performance.now() });
  }

  /** Client (CSS) coordinates to frame pixels. */
  toFramePx(clientX: number, clientY: number): [number, number] {
    const r = this.app.canvas.getBoundingClientRect();
    return [((clientX - r.left) / r.width) * this.app.screen.width, ((clientY - r.top) / r.height) * this.app.screen.height];
  }

  private render(): void {
    const f = this.frame;
    if (f) {
      const n = Math.min(this.sprites.length, f.length / STRIDE);
      for (let i = 0; i < n; i++) {
        const s = this.sprites[i];
        const o = i * STRIDE;
        s.position.set(f[o], f[o + 1]);
        s.rotation = f[o + 2];
        const target = f[o + 5] & FLAG_HELD ? 1.04 : 1;
        s.scale.set(s.scale.x + (target - s.scale.x) * 0.25);
      }
    }
    this.drawOverlay();
    this.drawXray();
  }

  private drawOverlay(): void {
    const g = this.overlay;
    g.clear();
    const now = performance.now();
    if (this.preparing) {
      const { width, height } = this.app.screen;
      const band = ((now / 1200) % 1) * (width + 400) - 200;
      g.rect(0, 0, width, height).fill({ color: 0x0b0e11, alpha: 0.18 });
      g.rect(band, 0, 160, height).fill({ color: 0xffffff, alpha: 0.06 });
    }
    for (const [key, r] of this.rings) {
      const age = (now - r.born) / 1000;
      if (r.ended === undefined) {
        const pulse = 0.5 + 0.5 * Math.sin(age * 6);
        g.circle(r.x, r.y, 14 + pulse * 6).stroke({ width: 3, color: 0x00ffd0, alpha: 0.9 });
        g.circle(r.x, r.y, 4).fill({ color: 0x00ffd0 });
      } else {
        const t = (now - r.ended) / 200; // reverse over about 200ms
        if (t >= 1) {
          this.rings.delete(key);
          continue;
        }
        g.circle(r.x, r.y, 20 * (1 - t)).stroke({ width: 3, color: r.failed ? 0xff5c5c : 0x00ffd0, alpha: 1 - t });
      }
    }
    this.pulses = this.pulses.filter((p) => now - p.born < 350);
    for (const p of this.pulses) {
      const t = (now - p.born) / 350;
      g.circle(p.x, p.y, 8 + t * 18).stroke({ width: 2, color: 0xffd54f, alpha: 1 - t });
    }
  }

  private drawXray(): void {
    const g = this.xray;
    g.clear();
    if (!this.xrayOn || !this.frame) return;
    const f = this.frame;
    const n = Math.min(this.geometry.length, f.length / STRIDE);
    for (let i = 0; i < n; i++) {
      const geo = this.geometry[i];
      const o = i * STRIDE;
      const x = f[o];
      const y = f[o + 1];
      const rot = f[o + 2];
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      for (const part of geo.parts_local_px) {
        const pts = part.flatMap(([px, py]) => [x + px * c - py * s, y + px * s + py * c]);
        g.poly(pts, true).stroke({ width: 2, color: geo.dynamic ? XRAY.hull : XRAY.hullFixed, alpha: 0.95 });
      }
      g.circle(x, y, 4).fill(XRAY.centroid);
      if (geo.floor_px) {
        const on = (f[o + 5] & FLAG_FLOOR_ACTIVE) !== 0;
        g.moveTo(geo.floor_px.x1, geo.floor_px.y)
          .lineTo(geo.floor_px.x2, geo.floor_px.y)
          .stroke({ width: on ? 2 : 1, color: on ? XRAY.floorOn : XRAY.floorOff, alpha: on ? 0.9 : 0.5 });
      }
      const vx = f[o + 3] * VEL_SCALE;
      const vy = f[o + 4] * VEL_SCALE;
      if (Math.hypot(vx, vy) > 2) g.moveTo(x, y).lineTo(x + vx, y + vy).stroke({ width: 2, color: XRAY.velocity });
    }
  }

  destroy(): void {
    this.app.destroy(true, { children: true, texture: true });
  }
}
