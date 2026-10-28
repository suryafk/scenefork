import { beforeAll, describe, expect, it } from 'vitest';
import { syntheticManifest } from '../scene/syntheticScene';
import { SimCore, dragGain, initRapier } from './SimCore';
import type { EntitySpec, Point, SceneManifest } from './types';

beforeAll(async () => {
  await initRapier();
});

const box = (x: number, y: number, w: number, h: number): Point[] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

function entity(id: string, polygon: Point[], mass: number, extra: Partial<EntitySpec> = {}): EntitySpec {
  return {
    id,
    label: id,
    body_type: 'dynamic',
    polygon_px: polygon,
    physics: { mass_kg: mass, restitution: 0.1, friction: 0.8 },
    acoustic_material: 'wood',
    z_index: 1,
    ...extra,
  };
}

function scene(entities: EntitySpec[]): SceneManifest {
  return {
    scene_id: 'test',
    resolution: { width: 1280, height: 720 },
    pixels_per_meter: 100,
    gravity_mps2: 9.81,
    ground_material: 'concrete',
    entities,
  };
}

const run = (sim: SimCore, steps: number) => {
  const events = [];
  for (let i = 0; i < steps; i++) events.push(...sim.step());
  return events;
};
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe('dragGain', () => {
  it('is capped for light objects and falls as mass^-0.4 for heavy ones', () => {
    expect(dragGain(0.5)).toBe(0.9);
    expect(dragGain(1)).toBeCloseTo(0.9);
    expect(dragGain(100)).toBeCloseTo(0.9 * Math.pow(100, -0.4));
    expect(dragGain(500)).toBeLessThan(dragGain(10));
  });
});

describe('own floors', () => {
  it('holds every synthetic entity where it was painted', () => {
    const sim = new SimCore(syntheticManifest);
    const start = new Map(sim.ids.map((id) => [id, sim.pose(id)]));
    run(sim, 120);
    for (const id of sim.ids) {
      expect(dist(sim.pose(id), start.get(id)!), id).toBeLessThan(3);
      expect(Math.abs(sim.pose(id).rot), id).toBeLessThan(0.05);
    }
    sim.free();
  });

  it('only holds up its owner: a near object is not lifted by a far object\'s floor', () => {
    // "far" sits higher in the frame, so its floor (y=461) cuts through "near" (y 430-600).
    const sim = new SimCore(scene([entity('far', box(500, 400, 80, 60), 10), entity('near', box(480, 430, 120, 170), 10)]));
    expect(sim.isExempt('far', 'near')).toBe(true); // they overlap on screen
    expect(sim.floorActive('far')).toBe(true); // in front of "near", not resting on it
    const near0 = sim.pose('near');
    const far0 = sim.pose('far');
    run(sim, 120);
    expect(dist(sim.pose('near'), near0)).toBeLessThan(3);
    expect(dist(sim.pose('far'), far0)).toBeLessThan(3);
    sim.free();
  });

  it('gives no own floor to an object resting on another, so it falls when the supporter leaves', () => {
    const sim = new SimCore(syntheticManifest);
    expect(sim.floorActive('bottle')).toBe(false);
    expect(sim.floorActive('crate')).toBe(true);
    const crate = sim.pose('crate');
    sim.grab(crate.x, crate.y);
    for (let i = 0; i < 60; i++) {
      sim.drag(crate.x - 6 * i, crate.y - 4 * i);
      sim.step();
    }
    sim.release();
    const bottle0 = sim.pose('bottle');
    run(sim, 90);
    expect(sim.pose('bottle').y - bottle0.y).toBeGreaterThan(50);
    sim.free();
  });

  it.each([
    ['pot first', ['pot', 'book']],
    ['book first', ['book', 'pot']],
  ])('drops a stacked object when its supporter is pulled out (%s)', (_, order) => {
    // Golden desk: the camera looks slightly down, so the pot's outline overlaps the book's top.
    const sim = new SimCore(scene([]));
    const specs = { pot: entity('pot', box(600, 300, 60, 70), 0.4), book: entity('book', box(540, 355, 180, 46), 0.7) };
    for (const id of order) sim.addEntity(specs[id as 'pot' | 'book']);
    expect(sim.isExempt('pot', 'book')).toBe(true); // they overlap on screen
    run(sim, 60);
    const pot0 = sim.pose('pot');
    expect(Math.abs(pot0.y - 335)).toBeLessThan(3); // still where it was painted
    const book = sim.pose('book');
    sim.grab(book.x, book.y);
    for (let i = 0; i < 40; i++) {
      sim.drag(book.x + 8 * i, book.y);
      sim.step();
    }
    sim.release();
    run(sim, 90);
    expect(sim.pose('pot').y - pot0.y).toBeGreaterThan(30); // pulled out from under it: it falls
    sim.free();
  });

  it('switches a lifted object to the global floor for good', () => {
    const sim = new SimCore(scene([entity('crate', box(600, 400, 80, 80), 15)]));
    const p0 = sim.pose('crate');
    sim.grab(p0.x, p0.y);
    for (let i = 0; i < 40; i++) {
      sim.drag(p0.x, p0.y - 5 * i);
      sim.step();
    }
    expect(sim.floorActive('crate')).toBe(false);
    sim.release();
    run(sim, 240);
    // Lands on the frame's bottom edge (720), not back on its own floor (481).
    expect(sim.pose('crate').y).toBeGreaterThan(720 - 40 - 3);
    sim.free();
  });
});

describe('spawn overlap', () => {
  it('lets the overlapping cone and truck sit still instead of exploding apart', () => {
    const sim = new SimCore(syntheticManifest);
    expect(sim.isExempt('truck', 'cone_2')).toBe(true);
    run(sim, 30);
    for (const id of ['truck', 'cone_2']) {
      const p = sim.pose(id);
      expect(Math.hypot(p.vx, p.vy), id).toBeLessThan(20); // px/s
    }
    sim.free();
  });

  it('ends the exemption once the pair has been apart for 10 steps', () => {
    const sim = new SimCore(syntheticManifest);
    const cone = sim.pose('cone_2');
    sim.grab(cone.x, cone.y + 20);
    for (let i = 0; i < 40; i++) {
      sim.drag(cone.x + 8 * i, cone.y);
      sim.step();
    }
    expect(sim.isExempt('truck', 'cone_2')).toBe(false);
    sim.free();
  });
});

describe('impulse-steering drag', () => {
  function follow(mass: number): number {
    const sim = new SimCore(scene([entity('thing', box(600, 500, 60, 60), mass)]));
    const p0 = sim.pose('thing');
    sim.grab(p0.x, p0.y);
    const target = { x: p0.x + 150, y: p0.y - 200 };
    for (let i = 0; i < 120; i++) {
      sim.drag(target.x, target.y);
      sim.step();
    }
    const err = dist(sim.pose('thing'), target);
    sim.free();
    return err;
  }

  it('brings heavy and light objects to the cursor, heavy ones visibly lagging', () => {
    const light = follow(0.6);
    const heavy = follow(500);
    expect(light).toBeLessThan(8);
    expect(heavy).toBeLessThan(60);
    expect(heavy).toBeGreaterThan(light);
  });

  it('keeps the release velocity so a flick throws the object', () => {
    const sim = new SimCore(scene([entity('ball', box(300, 500, 40, 40), 0.6, { physics: { mass_kg: 0.6, restitution: 0.8, friction: 0.9 } })]));
    const p0 = sim.pose('ball');
    sim.grab(p0.x, p0.y);
    for (let i = 0; i < 12; i++) {
      sim.drag(p0.x + 25 * i, p0.y - 10 * i);
      sim.step();
    }
    sim.release();
    const v = sim.pose('ball');
    expect(v.vx).toBeGreaterThan(300); // px/s, still flying right after release
    run(sim, 20);
    expect(sim.pose('ball').x).toBeGreaterThan(p0.x + 300);
    sim.free();
  });

  it('grabs only dynamic entities and returns null on empty space', () => {
    const sim = new SimCore(syntheticManifest);
    expect(sim.grab(20, 20)).toBeNull();
    expect(sim.grab(1048, 300)).toBeNull(); // fixed lamp post
    expect(sim.grab(500, 470)).toBe('truck');
    sim.free();
  });
});

describe('collision events', () => {
  it('reports a ground impact with speed and materials when something is dropped', () => {
    const sim = new SimCore(scene([entity('crate', box(600, 200, 60, 60), 15)]));
    const p0 = sim.pose('crate');
    sim.grab(p0.x, p0.y);
    sim.drag(p0.x, p0.y - 100); // lift off its own floor so it falls to the global floor
    run(sim, 30);
    sim.release();
    const events = run(sim, 120);
    const hit = events.find((e) => e.a === 'crate' && e.b === 'ground');
    expect(hit).toBeDefined();
    expect(hit!.speed_mps).toBeGreaterThan(2);
    expect(hit!.material_a).toBe('wood');
    expect(hit!.material_b).toBe('concrete');
    sim.free();
  });

  it('stays quiet for objects resting on their own floors', () => {
    const sim = new SimCore(syntheticManifest);
    expect(run(sim, 120)).toEqual([]);
    sim.free();
  });
});

describe('runtime entities (click-to-free)', () => {
  const groundingFor = (mass: number, extra: Partial<import('./types').Grounding> = {}): import('./types').Grounding => ({
    label: 'thing', body_type: 'dynamic', mass_kg: mass, restitution: 0.2, friction: 0.7,
    acoustic_material: 'ceramic', approx_height_m: 0.5, ...extra,
  });

  it('adds a freed object that rests on its own floor and can be grabbed', () => {
    const sim = new SimCore(scene([]));
    const geo = sim.addEntity(entity('obj_1', box(500, 400, 80, 80), 5));
    expect(sim.ids).toEqual(['obj_1']);
    expect(geo.floor_px?.y).toBeCloseTo(481);
    const p0 = sim.pose('obj_1');
    run(sim, 90);
    expect(dist(sim.pose('obj_1'), p0)).toBeLessThan(3);
    expect(sim.grab(540, 440)).toBe('obj_1');
    sim.free();
  });

  it('exempts a new object that overlaps one already freed', () => {
    const sim = new SimCore(scene([]));
    sim.addEntity(entity('obj_1', box(500, 400, 120, 120), 5));
    sim.addEntity(entity('obj_2', box(560, 470, 100, 100), 5));
    expect(sim.isExempt('obj_1', 'obj_2')).toBe(true);
    run(sim, 30);
    expect(Math.hypot(sim.pose('obj_2').vx, sim.pose('obj_2').vy)).toBeLessThan(20);
    sim.free();
  });

  it('rejects duplicate ids', () => {
    const sim = new SimCore(scene([]));
    sim.addEntity(entity('obj_1', box(500, 400, 80, 80), 5));
    expect(() => sim.addEntity(entity('obj_1', box(100, 400, 80, 80), 5))).toThrow(/duplicate/);
    sim.free();
  });

  it('applies grounding only once the body is at rest and not held', () => {
    const sim = new SimCore(scene([]));
    sim.addEntity(entity('obj_1', box(500, 300, 80, 80), 5));
    sim.addEntity(entity('obj_2', box(200, 300, 60, 60), 5));
    sim.grab(540, 340);
    sim.patch('obj_1', groundingFor(500));
    for (let i = 0; i < 20; i++) {
      sim.drag(540, 200);
      sim.step();
    }
    expect(sim.massOf('obj_1')).toBeCloseTo(5, 1); // still held: not applied
    sim.release();
    run(sim, 240); // falls, lands, settles
    expect(sim.massOf('obj_1')).toBeGreaterThan(100);
    expect(sim.labelOf('obj_1')).toBe('thing');
    sim.free();
  });

  it('turns an object grounded as fixed into a static body', () => {
    const sim = new SimCore(scene([]));
    sim.addEntity(entity('pole', box(600, 200, 20, 300), 5));
    sim.patch('pole', groundingFor(80, { body_type: 'fixed', label: 'street pole' }));
    run(sim, 5);
    expect(sim.isDynamic('pole')).toBe(false);
    expect(sim.grab(610, 300)).toBeNull();
    sim.free();
  });

  it('keeps the heaviest/lightest ratio at 200 as masses change', () => {
    const sim = new SimCore(scene([]));
    sim.addEntity(entity('a', box(100, 400, 60, 60), 5));
    sim.addEntity(entity('b', box(400, 400, 60, 60), 5));
    sim.patch('a', groundingFor(3000));
    sim.patch('b', groundingFor(0.3));
    run(sim, 3);
    expect(sim.massOf('a') / sim.massOf('b')).toBeCloseTo(200, 3);
    sim.free();
  });
});

describe('live forks: scale and floor (OV6)', () => {
  const live = (): SceneManifest => ({ ...scene([]), auto_floor: true });

  it('lands thrown objects on the ground the lowest freed object stood on', () => {
    const sim = new SimCore(live());
    expect(sim.floorLinePx).toBe(720);
    sim.addEntity(entity('crate', box(600, 400, 80, 80), 15)); // base at 480
    expect(sim.floorLinePx).toBe(481);
    sim.addEntity(entity('can', box(300, 300, 30, 50), 0.3)); // base at 350: higher, floor stays
    expect(sim.floorLinePx).toBe(481);
    const p0 = sim.pose('can');
    sim.grab(p0.x, p0.y);
    for (let i = 0; i < 30; i++) {
      sim.drag(p0.x, p0.y - 5 * i);
      sim.step();
    }
    sim.release();
    run(sim, 240);
    // Off its own floor for good, it falls to the crate's ground line, not the frame's bottom.
    expect(sim.pose('can').y).toBeGreaterThan(440);
    expect(sim.pose('can').y).toBeLessThan(470);
    // The floor line survives a snapshot restore.
    expect(SimCore.restore(sim.snapshot()).floorLinePx).toBe(481);
  });

  it('rescales a running world without moving anything on screen', () => {
    const sim = new SimCore(live());
    sim.addEntity(entity('crate', box(600, 400, 80, 80), 15));
    run(sim, 30);
    const before = sim.pose('crate');
    const big = SimCore.restore(SimCore.rescaleSnapshot(sim.snapshot(), 400));
    expect(big.ppm).toBe(400);
    expect(big.pose('crate').x).toBeCloseTo(before.x, 2);
    expect(big.pose('crate').y).toBeCloseTo(before.y, 2);
    run(big, 60);
    expect(Math.abs(big.pose('crate').y - before.y)).toBeLessThan(3); // still resting on its floor
  });

  it('keeps grounding that was still waiting when the world is rebuilt', () => {
    const sim = new SimCore(live());
    sim.addEntity(entity('crate', box(600, 400, 80, 80), 15));
    sim.grab(640, 440); // held: the patch waits
    sim.patch('crate', { label: 'wooden crate', body_type: 'dynamic', mass_kg: 40, restitution: 0.2, friction: 0.7, acoustic_material: 'wood', approx_height_m: 0.5 });
    sim.step();
    const restored = SimCore.restore(sim.snapshot());
    run(restored, 30);
    expect(restored.labelOf('crate')).toBe('wooden crate');
  });
});
