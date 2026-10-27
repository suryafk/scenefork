// Pixi v8 view of the simulation: clean plate, entity sprites anchored on their centroids,
// and the X-Ray overlay. Renders whatever the latest worker frame says; never simulates.
import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
import { boundingBox, spriteAnchor } from '../sim/geometry';
import { FLAG_FLOOR_ACTIVE, FLAG_HELD, STRIDE, type EntityGeometry, type SceneManifest } from '../sim/types';
import { paintPlate, paintSprite } from '../scene/syntheticScene';

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

export class SceneRenderer {
  readonly app = new Application();
  private readonly layer = new Container({ sortableChildren: true });
  private readonly xray = new Graphics();
  private sprites: Sprite[] = [];
  private geometry: EntityGeometry[] = [];
  private frame: Float32Array | null = null;
  xrayOn = false;

  async init(host: HTMLElement, manifest: SceneManifest): Promise<void> {
    const { width, height } = manifest.resolution;
    await this.app.init({ width, height, background: '#101418', antialias: true, autoDensity: true, resolution: window.devicePixelRatio });
    this.app.canvas.style.width = '100%';
    this.app.canvas.style.height = 'auto';
    this.app.canvas.style.display = 'block';
    this.app.canvas.style.touchAction = 'none';
    host.appendChild(this.app.canvas);
    const plate = new Sprite(Texture.from(paintPlate()));
    plate.zIndex = -1000;
    this.layer.addChild(plate);
    this.xray.zIndex = 10_000;
    this.layer.addChild(this.xray);
    this.app.stage.addChild(this.layer);
    this.app.ticker.add(() => this.render());
  }

  setScene(manifest: SceneManifest, ids: string[], geometry: EntityGeometry[]): void {
    for (const s of this.sprites) s.destroy({ texture: true });
    this.geometry = geometry;
    this.frame = null;
    this.sprites = ids.map((id) => {
      const spec = manifest.entities.find((e) => e.id === id)!;
      const bbox = boundingBox(spec.polygon_px);
      const g = geometry.find((x) => x.id === id)!;
      const sprite = new Sprite(Texture.from(paintSprite(spec, bbox)));
      const [ax, ay] = spriteAnchor(g.centroid_px, bbox);
      sprite.anchor.set(ax, ay);
      sprite.position.set(g.centroid_px[0], g.centroid_px[1]);
      sprite.zIndex = spec.z_index;
      this.layer.addChild(sprite);
      return sprite;
    });
  }

  pushFrame(buf: Float32Array): void {
    this.frame = buf;
  }

  /** Client (CSS) coordinates to frame pixels. */
  toFramePx(clientX: number, clientY: number): [number, number] {
    const r = this.app.canvas.getBoundingClientRect();
    return [((clientX - r.left) / r.width) * this.app.screen.width, ((clientY - r.top) / r.height) * this.app.screen.height];
  }

  private render(): void {
    const f = this.frame;
    if (f) {
      this.sprites.forEach((s, i) => {
        const o = i * STRIDE;
        s.position.set(f[o], f[o + 1]);
        s.rotation = f[o + 2];
        const target = f[o + 5] & FLAG_HELD ? 1.04 : 1;
        s.scale.set(s.scale.x + (target - s.scale.x) * 0.25);
      });
    }
    this.drawXray();
  }

  private drawXray(): void {
    const g = this.xray;
    g.clear();
    if (!this.xrayOn || !this.frame) return;
    const f = this.frame;
    this.geometry.forEach((geo, i) => {
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
    });
  }

  destroy(): void {
    this.app.destroy(true, { children: true, texture: true });
  }
}
