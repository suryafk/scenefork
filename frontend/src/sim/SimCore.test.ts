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
