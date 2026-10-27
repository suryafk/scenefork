// Phase 1 stand-in for a forked frame: a street scene with hand-made outlines in place of
// SAM masks and a painted clean plate in place of Muse Image. No model calls, no credits.
import { boundingBox } from '../sim/geometry';
import type { EntitySpec, Point, SceneManifest } from '../sim/types';

export const WIDTH = 1280;
export const HEIGHT = 720;

const circle = (cx: number, cy: number, r: number, n = 16): Point[] =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [Math.round(cx + r * Math.cos(a)), Math.round(cy + r * Math.sin(a))];
  });

const cone = (x: number, base: number, w: number, h: number): Point[] => [
  [x + w * 0.42, base - h],
  [x + w * 0.58, base - h],
  [x + w, base],
  [x, base],
];

/** Visual style per entity, used only for painting sprites. */
export const STYLE: Record<string, { fill: string; detail?: (ctx: CanvasRenderingContext2D, ox: number, oy: number) => void }> = {
  truck: {
    fill: '#c62828',
    detail: (ctx, ox, oy) => {
      ctx.fillStyle = '#a31f1f';
      ctx.fillRect(610 - ox, 430 - oy, 90, 100);
      ctx.fillStyle = '#b3e0f2';
      ctx.fillRect(630 - ox, 445 - oy, 56, 38);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 34px system-ui';
      ctx.fillText('FORK & CO', 405 - ox, 465 - oy);
      ctx.fillStyle = '#1b1b1b';
      for (const cx of [440, 650]) {
        ctx.beginPath();
        ctx.arc(cx - ox, 530 - oy, 30, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#9e9e9e';
      for (const cx of [440, 650]) {
        ctx.beginPath();
        ctx.arc(cx - ox, 530 - oy, 12, 0, Math.PI * 2);
        ctx.fill();
      }
    },
  },
  cone: {
    fill: '#fb8c00',
    detail: (ctx) => {
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      const { width, height } = ctx.canvas;
      ctx.fillRect(width * 0.25, height * 0.45, width * 0.5, height * 0.14);
    },
  },
  crate: {
    fill: '#a1712f',
    detail: (ctx) => {
      const { width, height } = ctx.canvas;
      ctx.strokeStyle = '#6d4a1c';
      ctx.lineWidth = 6;
      ctx.strokeRect(3, 3, width - 6, height - 6);
      ctx.beginPath();
      ctx.moveTo(3, 3);
      ctx.lineTo(width - 3, height - 3);
      ctx.moveTo(width - 3, 3);
      ctx.lineTo(3, height - 3);
      ctx.stroke();
    },
  },
  ball: {
    fill: '#43a047',
    detail: (ctx) => {
      const { width, height } = ctx.canvas;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(width / 2, height / 2, width * 0.32, 0, Math.PI * 2);
      ctx.stroke();
    },
  },
  bin: {
    fill: '#546e7a',
    detail: (ctx) => {
      const { width, height } = ctx.canvas;
      ctx.fillStyle = '#37474f';
      ctx.fillRect(0, 0, width, 10);
      for (let x = 10; x < width - 4; x += 12) ctx.fillRect(x, 16, 4, height - 22);
    },
  },
  bottle: { fill: 'rgba(120, 200, 160, 0.85)' },
  lamp: {
    fill: '#37474f',
    detail: (ctx) => {
      ctx.fillStyle = '#ffe082';
      ctx.fillRect(0, 0, ctx.canvas.width, 26);
    },
  },
};

export function styleKey(id: string): string {
  return id.replace(/_\d+$/, '');
}

const entities: EntitySpec[] = [
  {
    id: 'truck',
    label: 'red_delivery_truck',
    body_type: 'dynamic',
    // Concave outline (cargo box + lower cab): exercises convex decomposition.
    polygon_px: [[380, 380], [610, 380], [610, 430], [700, 430], [700, 560], [380, 560]],
    physics: { mass_kg: 2500, restitution: 0.15, friction: 0.7 },
    acoustic_material: 'hollow_metal',
    z_index: 3,
  },
  {
    id: 'cone_1',
    label: 'traffic_cone',
    body_type: 'dynamic',
    polygon_px: cone(170, 575, 56, 80),
    physics: { mass_kg: 3, restitution: 0.3, friction: 0.8 },
    acoustic_material: 'plastic',
    z_index: 4,
  },
  {
    id: 'cone_2',
    label: 'traffic_cone',
    body_type: 'dynamic',
    // Overlaps the truck's front corner on screen: exercises the spawn-overlap exemption.
    polygon_px: cone(680, 620, 64, 92),
    physics: { mass_kg: 3, restitution: 0.3, friction: 0.8 },
    acoustic_material: 'plastic',
    z_index: 5,
  },
  {
    id: 'crate',
    label: 'wooden_crate',
    body_type: 'dynamic',
    polygon_px: [[880, 420], [970, 420], [970, 510], [880, 510]],
    physics: { mass_kg: 15, restitution: 0.2, friction: 0.7 },
    acoustic_material: 'wood',
    z_index: 2,
  },
  {
    id: 'bottle',
    label: 'glass_bottle',
    body_type: 'dynamic',
    // Stands on the crate: its own floor is the crate's top.
    polygon_px: [[916, 360], [934, 360], [936, 382], [946, 396], [946, 419], [904, 419], [904, 396], [914, 382]],
    physics: { mass_kg: 0.5, restitution: 0.25, friction: 0.5 },
    acoustic_material: 'glass',
    z_index: 2,
  },
  {
    id: 'ball',
    label: 'rubber_ball',
    body_type: 'dynamic',
    polygon_px: circle(1110, 628, 28),
    physics: { mass_kg: 0.6, restitution: 0.85, friction: 0.9 },
    acoustic_material: 'rubber',
    z_index: 6,
  },
  {
    id: 'bin',
    label: 'metal_trash_bin',
    body_type: 'dynamic',
    polygon_px: [[1180, 430], [1250, 430], [1244, 515], [1186, 515]],
    physics: { mass_kg: 20, restitution: 0.2, friction: 0.6 },
    acoustic_material: 'hollow_metal',
    z_index: 2,
  },
  {
    id: 'lamp',
    label: 'street_lamp_post',
    body_type: 'fixed',
    polygon_px: [[1040, 230], [1056, 230], [1056, 512], [1040, 512]],
    physics: { mass_kg: 0, restitution: 0.3, friction: 0.6 },
    acoustic_material: 'solid_metal',
    z_index: 1,
  },
];

export const syntheticManifest: SceneManifest = {
  scene_id: 'synthetic_street_01',
  resolution: { width: WIDTH, height: HEIGHT },
  pixels_per_meter: 100,
  gravity_mps2: 9.81,
  ground_material: 'concrete',
  entities,
};

/** Clean plate: the street with every entity removed (Muse Image's job in Phase 2). */
export function paintPlate(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = WIDTH;
  c.height = HEIGHT;
  const ctx = c.getContext('2d')!;
  const sky = ctx.createLinearGradient(0, 0, 0, 470);
  sky.addColorStop(0, '#7fb3e6');
  sky.addColorStop(1, '#cfe4f5');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, WIDTH, 470);
  // Buildings
  const blocks: [number, number, number, string][] = [
    [0, 190, 210, '#8d7b68'],
    [210, 120, 160, '#a39382'],
    [370, 220, 260, '#7b6d61'],
    [630, 150, 180, '#958676'],
    [810, 90, 230, '#86776a'],
    [1040, 170, 240, '#9c8c7b'],
  ];
  for (const [x, top, w, color] of blocks) {
    ctx.fillStyle = color;
    ctx.fillRect(x, top, w, 470 - top);
    ctx.fillStyle = 'rgba(255, 244, 214, 0.55)';
    for (let wy = top + 20; wy < 430; wy += 44) {
      for (let wx = x + 16; wx < x + w - 30; wx += 40) ctx.fillRect(wx, wy, 22, 26);
    }
  }
  // Sidewalk, curb, road
  ctx.fillStyle = '#b8b2a7';
  ctx.fillRect(0, 470, WIDTH, 50);
  ctx.fillStyle = '#8f8a82';
  ctx.fillRect(0, 516, WIDTH, 8);
  ctx.fillStyle = '#4a4a4f';
  ctx.fillRect(0, 524, WIDTH, HEIGHT - 524);
  ctx.fillStyle = '#e8d36a';
  for (let x = 20; x < WIDTH; x += 120) ctx.fillRect(x, 640, 70, 8);
  return c;
}

/** Sprite for one entity: its outline filled and detailed, cropped to its bounding box. */
export function paintSprite(spec: EntitySpec, bbox: { x: number; y: number; w: number; h: number }): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.ceil(bbox.w);
  c.height = Math.ceil(bbox.h);
  const ctx = c.getContext('2d')!;
  const style = STYLE[styleKey(spec.id)] ?? { fill: '#999' };
  ctx.beginPath();
  spec.polygon_px.forEach(([x, y], i) => (i ? ctx.lineTo(x - bbox.x, y - bbox.y) : ctx.moveTo(x - bbox.x, y - bbox.y)));
  ctx.closePath();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = style.fill;
  ctx.fillRect(0, 0, c.width, c.height);
  style.detail?.(ctx, bbox.x, bbox.y);
  ctx.restore();
  return c;
}

/** The street as a camera would see it (plate plus every object): a test frame to fork. */
export function paintFullFrame(): HTMLCanvasElement {
  const c = paintPlate();
  const ctx = c.getContext('2d')!;
  for (const spec of [...entities].sort((a, b) => a.z_index - b.z_index)) {
    const bbox = boundingBox(spec.polygon_px);
    ctx.drawImage(paintSprite(spec, bbox), bbox.x, bbox.y);
  }
  return c;
}
