// Physics world shared by the live PhysicsWorker and the verifier worker (eng review D2).
// Pure: no Pixi, no DOM. Rapier runs in meters; pixels only cross this boundary through
// `pixels_per_meter`. Owns the rule stack and the plugin `ctx` API (shared/ctx.d.ts).
import RAPIER from '@dimforge/rapier2d-compat';
import { boundingBox, compressMasses, polygonArea, polygonCentroid, toConvexParts } from './geometry';
import {
  MAX_PLUGINS,
  RuleStack,
  isDeclared,
  parseWrite,
  writeSetsConflict,
  type Bindings,
  type FieldKey,
  type FieldValue,
  type FloatNudge,
  type PresetWrite,
  type RuleDef,
  type RuleEvent,
  type RuleInfo,
} from './rules';
import { compilePlugin, type HookName, type Hooks } from './sandbox';
import {
  FLAG_FLOOR_ACTIVE,
  FLAG_HELD,
  STRIDE,
  type AcousticMaterial,
  type CollisionEvent,
  type EntityGeometry,
  type EntitySpec,
  type Grounding,
  type Point,
  type SceneManifest,
} from './types';

let initPromise: Promise<void> | null = null;
export function initRapier(): Promise<void> {
  return (initPromise ??= RAPIER.init());
}

export const DT = 1 / 60;
/** Drag spring: desired grab-point velocity per meter of pointer error (1/s). */
const DRAG_STIFFNESS = 12;
const MAX_DRAG_SPEED = 30;
const MAX_THROW_SPEED = 25;
const HELD_ANGULAR_DAMPING = 6;
/**
 * Rapier averages two surfaces' bounciness by default, so a 0.8 ball on a 0.1 floor bounced like 0.45
 * (measured: 17% of its drop height instead of about 64%). The bouncier surface wins instead: the
 * floors and walls here only stand in for a real table, whose give is already in the object's value.
 */
const BOUNCE_RULE = RAPIER.CoefficientCombineRule.Max;
/** A press this close outside a body still grabs it: hulls are simplified, the sprite's edge isn't. */
const GRAB_SLOP_PX = 10;
/** Steps a spawn-overlapping pair must stay apart before it collides normally. */
const OVERLAP_CLEAR_STEPS = 10;
const MIN_IMPACT_SPEED = 0.8;
const IMPACT_COOLDOWN_STEPS = 5;
const GROUND = 'ground';
/** Design: Misbehaving plugins. A hook over this budget for this many steps in a row is unloaded. */
const SLOW_HOOK_MS = 4;
const SLOW_HOOK_STEPS = 3;
const MAX_LOG_LINES = 50;
/** The ceiling turns on when downward gravity is weaker than this (zero, reversed, sideways). */
const CEILING_BELOW_GRAVITY = 1;

/**
 * Fraction of the velocity error the drag corrects per step. The impulse is
 * mass * gain = mass^0.6 * 0.9 (OV7), capped at 0.9 so light objects don't overshoot:
 * a 500 kg truck visibly lags the cursor, a 2 kg ball snaps to it.
 */
export function dragGain(massKg: number): number {
  return Math.min(0.9, 0.9 * Math.pow(Math.max(massKg, 1e-3), -0.4));
}

/** Small seeded PRNG (mulberry32): one seed per verification run and its baseline (outside voice #17). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface BodyRec {
  id: string;
  spec: EntitySpec;
  body: RAPIER.RigidBody;
  colliders: RAPIER.Collider[];
  dynamic: boolean;
  massKg: number;
  /** Effective mass before compression: the stacked value, else the grounded or default one. */
  rawMassKg: number;
  /** Each part collider's share of the body's area, for splitting mass. */
  areaFractions: number[];
  material: AcousticMaterial;
  centroidPx: Point;
  partsLocalPx: Point[][];
  floor: RAPIER.Collider | null;
  floorActive: boolean;
  /**
   * Bodies this one sits on whose outlines overlap it on screen (a camera looking down at a stack).
   * Its own floor holds it only while one of them is still underneath.
   */
  supporters: BodyRec[];
  floorY: number;
  floorX1: number;
  floorX2: number;
  /** Distance from the body origin down to its lowest point at spawn, in meters. */
  bottomOffset: number;
  halfHeight: number;
  widthM: number;
}

interface Held {
  rec: BodyRec;
  /** Grab point in body-local meters. */
  local: { x: number; y: number };
  target: { x: number; y: number };
}

interface ActiveRule {
  def: RuleDef;
  /** Declared write patterns: replacement and the undeclared-write check both use them. */
  declared: string[];
  hooks: Hooks;
  ticks: number;
  ageS: number;
  /** Hook time spent in the current step, and how many steps in a row ran over budget. */
  stepMs: number;
  slowSteps: number;
}

/** Everything a fresh SimCore needs to stand in for this one (watchdog restore, verifier). */
export interface SimSnapshot {
  /** Entities carry their base (grounded or default) physics, in body order. */
  manifest: SceneManifest;
  bodies: { id: string; x: number; y: number; rot: number; vx: number; vy: number; w: number; floorActive: boolean }[];
  /** Presets survive a restart; plugins don't (design: Runtime watchdog). */
  presets: RuleDef[];
  /** Grounding still waiting for its body to come to rest. */
  pending?: [string, Grounding][];
}

export interface EntityView {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly speed: number;
  readonly angle: number;
  readonly angularVelocity: number;
  readonly mass: number;
  readonly restitution: number;
  readonly friction: number;
  readonly dynamic: boolean;
  readonly held: boolean;
  readonly width: number;
  readonly height: number;
}

export interface SimOptions {
  /** Seed for ctx.random and plugin Math.random. */
  seed?: number;
}

const rotate = (v: { x: number; y: number }, a: number) => ({
  x: v.x * Math.cos(a) - v.y * Math.sin(a),
  y: v.x * Math.sin(a) + v.y * Math.cos(a),
});
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const entityKey = (id: string, field: string): FieldKey => `entity:${id}.${field}`;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function finite(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${what} must be a finite number, got ${String(v)}`);
  return v;
}

export class SimCore {
  readonly world: RAPIER.World;
  readonly ppm: number;
  readonly ids: string[] = [];
  private readonly manifest: SceneManifest;
  private readonly eventQueue: RAPIER.EventQueue;
  private readonly recs = new Map<string, BodyRec>();
  private readonly colliderOwner = new Map<number, string>();
  /** Own-floor collider handle → owning entity id. */
  private readonly floorOwner = new Map<number, string>();
  /** Spawn-overlapping pairs whose contacts are ignored, with steps spent apart. */
  private readonly exempt = new Map<string, { a: BodyRec; b: BodyRec; clearSteps: number }>();
  private readonly lastImpact = new Map<string, number>();
  private readonly preStepVel = new Map<string, { x: number; y: number }>();
  private readonly ground: RAPIER.RigidBody;
  private groundFloor!: RAPIER.Collider;
  /** The frame's top edge: on only when gravity isn't pulling down, so floating things stay in view. */
  private ceiling!: RAPIER.Collider;
  /** Live forks: the current floor line in pixels, following the lowest freed object. */
  private autoFloorPx: number | null = null;
  private held: Held | null = null;
  private stepCount = 0;
  /** Grounding results waiting for their body to come to rest (design step 5). */
  private readonly pendingPatches = new Map<string, Grounding>();

  private readonly stack = new RuleStack();
  /** Active rules, oldest first. */
  private readonly rules: ActiveRule[] = [];
  private ruleEvents: RuleEvent[] = [];
  private logs: string[] = [];
  private timeScale = 1;
  readonly random: () => number;
  /** Set while restore() reloads presets onto bodies that already have their velocities. */
  private replaying = false;
  /** Rule whose hook is running right now; the worker reports it so the watchdog can name a culprit. */
  running: string | null = null;
  /** Called as a plugin hook starts (the live worker posts it before a possible freeze). */
  onHookEnter: ((ruleId: string) => void) | null = null;

  private readonly hooks: RAPIER.PhysicsHooks = {
    filterContactPair: (c1, c2) => {
      const f1 = this.floorOwner.get(c1);
      const f2 = this.floorOwner.get(c2);
      if (f1 !== undefined || f2 !== undefined) {
        // An own floor only holds up its owner, and only until the owner leaves it.
        const ownerId = (f1 ?? f2)!;
        const other = f1 !== undefined ? c2 : c1;
        const rec = this.recs.get(ownerId)!;
        return rec.floorActive && this.colliderOwner.get(other) === ownerId ? RAPIER.SolverFlags.COMPUTE_IMPULSE : null;
      }
      const o1 = this.colliderOwner.get(c1);
      const o2 = this.colliderOwner.get(c2);
      if (o1 !== undefined && o2 !== undefined && this.exempt.has(pairKey(o1, o2))) return null;
      return RAPIER.SolverFlags.COMPUTE_IMPULSE;
    },
    filterIntersectionPair: () => true,
  };

  /** Call `await initRapier()` first. */
  constructor(manifest: SceneManifest, opts: SimOptions = {}) {
    this.manifest = manifest;
    this.ppm = manifest.pixels_per_meter;
    this.random = seededRandom(opts.seed ?? 0x5ce4e);
    this.world = new RAPIER.World({ x: 0, y: manifest.gravity_mps2 });
    this.world.numSolverIterations = 8;
    this.eventQueue = new RAPIER.EventQueue(true);
    this.ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.stack.setBase('world.gravity', [0, manifest.gravity_mps2]);
    this.stack.setBase('world.time_scale', 1);
    this.buildBounds();

    for (const spec of manifest.entities) this.buildEntity(spec);
    // Collider poses are only written during a step; shape tests at spawn need them now.
    this.world.propagateModifiedBodyPositionsToColliders();
    this.findSpawnOverlaps();
    this.rebalanceMasses();
    for (const rec of this.recs.values()) if (rec.dynamic) this.buildOwnFloor(rec);
  }

  /** Rebuild a world from a snapshot: same bodies, poses and presets, no plugins. */
  static restore(snap: SimSnapshot, opts: SimOptions = {}): SimCore {
    const sim = new SimCore(snap.manifest, opts);
    for (const b of snap.bodies) {
      const rec = sim.recs.get(b.id);
      if (!rec) continue;
      rec.body.setTranslation({ x: b.x, y: b.y }, true);
      rec.body.setRotation(b.rot, true);
      rec.body.setLinvel({ x: b.vx, y: b.vy }, true);
      rec.body.setAngvel(b.w, true);
      rec.floorActive = rec.floorActive && b.floorActive;
    }
    sim.world.propagateModifiedBodyPositionsToColliders();
    // The bodies already carry the velocities a float gave them: don't push them again.
    sim.replaying = true;
    for (const p of snap.presets) sim.loadRule(p);
    sim.replaying = false;
    for (const [id, g] of snap.pending ?? []) sim.patch(id, g);
    sim.ruleEvents = [];
    return sim;
  }

  /** The same scene at a new scale: pixel positions stay put, meters change (OV6). */
  static rescaleSnapshot(snap: SimSnapshot, ppm: number): SimSnapshot {
    const k = snap.manifest.pixels_per_meter / ppm;
    return {
      ...snap,
      manifest: { ...snap.manifest, pixels_per_meter: ppm },
      bodies: snap.bodies.map((b) => ({ ...b, x: b.x * k, y: b.y * k, vx: b.vx * k, vy: b.vy * k })),
    };
  }

  snapshot(): SimSnapshot {
    return {
      manifest: {
        ...this.manifest,
        entities: this.ids.map((id) => this.recs.get(id)!.spec),
        ...(this.autoFloorPx !== null ? { floor_y_px: this.autoFloorPx } : {}),
      },
      bodies: this.ids.map((id) => {
        const rec = this.recs.get(id)!;
        const t = rec.body.translation();
        const v = rec.body.linvel();
        return { id, x: t.x, y: t.y, rot: rec.body.rotation(), vx: v.x, vy: v.y, w: rec.body.angvel(), floorActive: rec.floorActive };
      }),
      presets: this.rules.filter((r) => r.def.kind === 'preset').map((r) => r.def),
      pending: [...this.pendingPatches],
    };
  }

  /** Free one more object into the running world (click-to-free). */
  addEntity(spec: EntitySpec): EntityGeometry {
    if (this.recs.has(spec.id)) throw new Error(`duplicate entity ${spec.id}`);
    const rec = this.buildEntity(spec);
    this.world.propagateModifiedBodyPositionsToColliders();
    if (rec.dynamic) {
      for (const other of this.recs.values()) {
        if (other !== rec && other.dynamic && this.partsIntersect(rec, other)) {
          this.exempt.set(pairKey(rec.id, other.id), { a: rec, b: other, clearSteps: 0 });
        }
      }
      this.rebalanceMasses();
      this.buildOwnFloor(rec);
      if (this.manifest.auto_floor) {
        // Thrown objects land on the ground the lowest freed object stood on.
        const base = Math.round(rec.floorY * this.ppm);
        if (this.autoFloorPx === null || base > this.autoFloorPx) this.setFloorLine(base);
      }
      // Objects already freed that sit on this one (a pot freed before the book under it) now
      // keep their floor only while it stays underneath, whatever order they were freed in.
      for (const other of this.recs.values()) {
        if (other !== rec && other.floorActive && this.restsOn(other, rec)) other.supporters.push(rec);
      }
    }
    // Scene-wide presets ("make everything bouncy") cover objects freed after them too, and an
    // object freed into zero gravity floats off like the rest instead of sitting on its floor.
    for (const rule of this.rules) {
      if (rule.def.kind !== 'preset' || rule.def.targets !== null || !rec.dynamic) continue;
      for (const w of rule.def.writes) if (w.field.startsWith('entity:*.')) this.write(rule, entityKey(rec.id, w.field.slice(9)), w.value);
      if (rule.def.float) this.floatOff([rec.id], rule.def.float);
    }
    return this.geometryOf(rec);
  }

  /** Queue grounded physics for an entity; applied once it is at rest and not held. */
  patch(id: string, g: Grounding): void {
    if (this.recs.has(id)) this.pendingPatches.set(id, g);
  }

  /** Compress raw masses across all dynamic bodies (OV7: ratio at most 200:1) and apply them. */
  private rebalanceMasses(): void {
    const dyn = [...this.recs.values()].filter((r) => r.dynamic);
    const masses = compressMasses(dyn.map((r) => r.rawMassKg));
    dyn.forEach((rec, i) => {
      rec.colliders.forEach((c, j) => c.setMass(masses[i] * rec.areaFractions[j]));
      // Rapier would only pick this up at the next step; impulses before it (onInit) need it now.
      rec.body.recomputeMassPropertiesFromColliders();
      rec.massKg = masses[i];
    });
  }

  private applyPendingPatches(): void {
    for (const [id, g] of this.pendingPatches) {
      const rec = this.recs.get(id)!;
      if (this.held?.rec === rec) continue;
      const v = rec.body.linvel();
      if (Math.hypot(v.x, v.y) > 0.3 || Math.abs(rec.body.angvel()) > 0.5) continue;
      this.pendingPatches.delete(id);
      // Grounding sets the base values; a rule that overrides a field keeps winning.
      const fixedNow = rec.dynamic && g.body_type === 'fixed';
      rec.spec = {
        ...rec.spec,
        label: g.label,
        acoustic_material: g.acoustic_material,
        body_type: rec.spec.body_type === 'fixed' ? 'fixed' : g.body_type,
        physics: { mass_kg: g.mass_kg, restitution: g.restitution, friction: g.friction },
      };
      rec.material = g.acoustic_material;
      this.stack.setBase(entityKey(id, 'restitution'), g.restitution);
      this.stack.setBase(entityKey(id, 'friction'), g.friction);
      this.stack.setBase(entityKey(id, 'mass'), g.mass_kg);
      this.stack.setBase(entityKey(id, 'body_type'), rec.spec.body_type);
      // A wall or pole the user freed by mistake stops moving, at rest where it is.
      if (fixedNow) rec.floorActive = false;
      for (const f of ['restitution', 'friction', 'mass', 'body_type']) this.applyField(entityKey(id, f));
    }
  }

  private buildBounds(): void {
    const w = this.manifest.resolution.width / this.ppm;
    const h = this.manifest.resolution.height / this.ppm;
    const add = (desc: RAPIER.ColliderDesc) => {
      const c = this.world.createCollider(desc.setFriction(0.8).setRestitution(0.15).setRestitutionCombineRule(BOUNCE_RULE), this.ground);
      this.colliderOwner.set(c.handle, GROUND);
      return c;
    };
    // Global floor: top face on the scene's floor line (golden clips can set one, e.g. a desk
    // surface), else the frame's bottom edge. Walls reach well above the frame so thrown
    // objects come back down instead of leaving the scene.
    const floorY = (this.manifest.floor_y_px ?? this.manifest.resolution.height) / this.ppm;
    this.groundFloor = add(RAPIER.ColliderDesc.cuboid(w / 2 + 2, 1).setTranslation(w / 2, floorY + 1));
    if (this.manifest.auto_floor) this.autoFloorPx = this.manifest.floor_y_px ?? null;
    add(RAPIER.ColliderDesc.cuboid(1, h * 3).setTranslation(-1, 0));
    add(RAPIER.ColliderDesc.cuboid(1, h * 3).setTranslation(w + 1, 0));
    this.ceiling = add(RAPIER.ColliderDesc.cuboid(w / 2 + 2, 1).setTranslation(w / 2, -1));
    this.ceiling.setEnabled(this.manifest.gravity_mps2 < CEILING_BELOW_GRAVITY);
  }

  private buildEntity(spec: EntitySpec): BodyRec {
    const ppm = this.ppm;
    const dynamic = spec.body_type === 'dynamic';
    const centroid = polygonCentroid(spec.polygon_px);
    const parts = toConvexParts(spec.polygon_px);
    const totalArea = parts.reduce((s, p) => s + polygonArea(p), 0) || 1;

    const bodyDesc = (dynamic ? RAPIER.RigidBodyDesc.dynamic().setCcdEnabled(true) : RAPIER.RigidBodyDesc.fixed())
      .setTranslation(centroid[0] / ppm, centroid[1] / ppm);
    const body = this.world.createRigidBody(bodyDesc);

    const partsLocalPx = parts.map((part) => part.map(([x, y]): Point => [x - centroid[0], y - centroid[1]]));
    const colliders: RAPIER.Collider[] = [];
    const areaFractions: number[] = [];
    partsLocalPx.forEach((local, i) => {
      const desc = RAPIER.ColliderDesc.convexHull(new Float32Array(local.flatMap(([x, y]) => [x / ppm, y / ppm])));
      if (!desc) return;
      this.configurePart(desc, spec);
      areaFractions.push(polygonArea(parts[i]) / totalArea);
      colliders.push(this.world.createCollider(desc, body));
    });
    if (!colliders.length) {
      const bb = boundingBox(spec.polygon_px);
      const desc = RAPIER.ColliderDesc.cuboid(bb.w / 2 / ppm, bb.h / 2 / ppm).setTranslation(
        (bb.x + bb.w / 2 - centroid[0]) / ppm,
        (bb.y + bb.h / 2 - centroid[1]) / ppm,
      );
      this.configurePart(desc, spec);
      areaFractions.length = 0;
      areaFractions.push(1);
      colliders.push(this.world.createCollider(desc, body));
    }
    for (const c of colliders) this.colliderOwner.set(c.handle, spec.id);

    const bb = boundingBox(spec.polygon_px);
    const maxY = bb.y + bb.h;
    const rec: BodyRec = {
      id: spec.id,
      spec,
      body,
      colliders,
      dynamic,
      massKg: 0,
      rawMassKg: spec.physics.mass_kg,
      areaFractions,
      material: spec.acoustic_material,
      centroidPx: centroid,
      partsLocalPx,
      floor: null,
      floorActive: false,
      supporters: [],
      floorY: (maxY + 1) / ppm,
      floorX1: (centroid[0] - 0.75 * bb.w) / ppm,
      floorX2: (centroid[0] + 0.75 * bb.w) / ppm,
      bottomOffset: (maxY - centroid[1]) / ppm,
      halfHeight: bb.h / 2 / ppm,
      widthM: bb.w / ppm,
    };
    this.recs.set(spec.id, rec);
    this.ids.push(spec.id);
    this.stack.setBase(entityKey(spec.id, 'mass'), spec.physics.mass_kg);
    this.stack.setBase(entityKey(spec.id, 'restitution'), spec.physics.restitution);
    this.stack.setBase(entityKey(spec.id, 'friction'), spec.physics.friction);
    this.stack.setBase(entityKey(spec.id, 'damping'), 0);
    this.stack.setBase(entityKey(spec.id, 'body_type'), spec.body_type);
    return rec;
  }

  /** Move the global floor so its top face sits at a frame-pixel y. */
  setFloorLine(yPx: number): void {
    this.autoFloorPx = yPx;
    const w = this.manifest.resolution.width / this.ppm;
    this.groundFloor.setTranslationWrtParent({ x: w / 2, y: yPx / this.ppm + 1 });
    for (const rec of this.recs.values()) if (rec.dynamic) rec.body.wakeUp();
  }

  get floorLinePx(): number {
    return this.autoFloorPx ?? this.manifest.floor_y_px ?? this.manifest.resolution.height;
  }

  /** Just under the middle of a body's lowest point: where a supporter would be. */
  private pointBelow(rec: BodyRec): { x: number; y: number } {
    const t = rec.body.translation();
    return { x: t.x, y: t.y + rec.bottomOffset + 2 / this.ppm };
  }

  private buildOwnFloor(rec: BodyRec): void {
    // An object resting on another dynamic object (a bottle on a crate) gets no own floor:
    // its supporter holds it up, so it falls when the supporter is pulled away. A pair that
    // overlaps on screen is one object in front of another, not support.
    // Tested against where the other bodies are now, not where they were painted, since
    // objects freed later can land on (or next to) ones already moved.
    const below = this.pointBelow(rec);
    const supported = [...this.recs.values()].some(
      (o) => o !== rec && o.dynamic && !this.isExempt(o.id, rec.id) && o.colliders.some((c) => c.containsPoint(below)),
    );
    if (supported) return;
    // Own floor (eng review: floors via the contact filter, not collision groups): a segment
    // 1px under the object's lowest point, 1.5x its width, that only holds up its owner.
    const floor = this.world.createCollider(
      RAPIER.ColliderDesc.segment({ x: rec.floorX1, y: rec.floorY }, { x: rec.floorX2, y: rec.floorY })
        .setFriction(0.8)
        .setRestitution(0.1)
        .setRestitutionCombineRule(BOUNCE_RULE)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
        .setActiveHooks(RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS),
      this.ground,
    );
    rec.floor = floor;
    rec.floorActive = true;
    this.floorOwner.set(floor.handle, rec.id);
    rec.supporters = [...this.recs.values()].filter((o) => o !== rec && this.restsOn(rec, o));
  }

  /**
   * Support, not occlusion: `upper` stands on `lower` when its center is above lower's top and
   * its base lands inside lower. A far object behind a near one fails the first test.
   */
  private restsOn(upper: BodyRec, lower: BodyRec): boolean {
    if (!lower.dynamic) return false;
    const lowerTop = lower.body.translation().y - lower.halfHeight;
    return upper.body.translation().y < lowerTop && lower.colliders.some((c) => c.containsPoint(this.pointBelow(upper)));
  }

  private configurePart(desc: RAPIER.ColliderDesc, spec: EntitySpec): void {
    desc
      .setRestitution(spec.physics.restitution)
      .setRestitutionCombineRule(BOUNCE_RULE)
      .setFriction(spec.physics.friction)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
      .setActiveHooks(RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS);
  }

  private partsIntersect(a: BodyRec, b: BodyRec): boolean {
    for (const ca of a.colliders) {
      for (const cb of b.colliders) {
        if (ca.intersectsShape(cb.shape, cb.translation(), cb.rotation())) return true;
      }
    }
    return false;
  }

  private findSpawnOverlaps(): void {
    const dyn = [...this.recs.values()].filter((r) => r.dynamic);
    for (let i = 0; i < dyn.length; i++) {
      for (let j = i + 1; j < dyn.length; j++) {
        if (this.partsIntersect(dyn[i], dyn[j])) {
          this.exempt.set(pairKey(dyn[i].id, dyn[j].id), { a: dyn[i], b: dyn[j], clearSteps: 0 });
        }
      }
    }
  }

  isExempt(a: string, b: string): boolean {
    return this.exempt.has(pairKey(a, b));
  }

  floorActive(id: string): boolean {
    return this.recs.get(id)?.floorActive ?? false;
  }

  /** Grab the topmost dynamic entity under a point in frame pixels. */
  grab(xPx: number, yPx: number): string | null {
    const p = { x: xPx / this.ppm, y: yPx / this.ppm };
    // Test our own colliders directly: the query BVH only refreshes inside world.step.
    let rec: BodyRec | null = null;
    for (const r of this.recs.values()) {
      if (r.dynamic && (!rec || r.spec.z_index > rec.spec.z_index) && r.colliders.some((c) => c.containsPoint(p))) rec = r;
    }
    let at = p;
    if (!rec) {
      // Nothing under the pointer: the nearest body within the slop, held at its closest edge point.
      let best = GRAB_SLOP_PX / this.ppm;
      for (const r of this.recs.values()) {
        if (!r.dynamic) continue;
        for (const c of r.colliders) {
          const proj = c.projectPoint(p, true);
          const d = proj ? Math.hypot(proj.point.x - p.x, proj.point.y - p.y) : Infinity;
          if (d <= best) [best, rec, at] = [d, r, { x: proj!.point.x, y: proj!.point.y }];
        }
      }
    }
    if (!rec) return null;
    const t = rec.body.translation();
    this.startHold(rec, rotate({ x: at.x - t.x, y: at.y - t.y }, -rec.body.rotation()), p);
    return rec.id;
  }

  /** Grab an entity at its origin (verifier dragRelease scenarios). */
  grabById(id: string): boolean {
    const rec = this.recs.get(id);
    if (!rec?.dynamic) return false;
    const t = rec.body.translation();
    this.startHold(rec, { x: 0, y: 0 }, { x: t.x, y: t.y });
    return true;
  }

  private startHold(rec: BodyRec, local: { x: number; y: number }, target: { x: number; y: number }): void {
    this.held = { rec, local, target };
    rec.body.setAngularDamping(HELD_ANGULAR_DAMPING);
    rec.body.wakeUp();
    this.dispatch('onGrab', rec.id);
  }

  drag(xPx: number, yPx: number): void {
    if (this.held) this.held.target = { x: xPx / this.ppm, y: yPx / this.ppm };
  }

  release(): void {
    if (!this.held) return;
    const { rec } = this.held;
    const body = rec.body;
    body.setAngularDamping(0);
    const v = body.linvel();
    const speed = Math.hypot(v.x, v.y);
    if (speed > MAX_THROW_SPEED) body.setLinvel({ x: (v.x / speed) * MAX_THROW_SPEED, y: (v.y / speed) * MAX_THROW_SPEED }, true);
    this.held = null;
    this.dispatch('onRelease', rec.id);
  }

  get heldId(): string | null {
    return this.held?.rec.id ?? null;
  }

  /** Impulse steering at the grab point (eng review D3 + OV7). */
  private applyDrag(): void {
    if (!this.held) return;
    const { rec, local, target } = this.held;
    const body = rec.body;
    const t = body.translation();
    const off = rotate(local, body.rotation());
    const grab = { x: t.x + off.x, y: t.y + off.y };
    const com = body.worldCom();
    const v = body.linvel();
    const w = body.angvel();
    const r = { x: grab.x - com.x, y: grab.y - com.y };
    const pointVel = { x: v.x - w * r.y, y: v.y + w * r.x };
    let desired = { x: (target.x - grab.x) * DRAG_STIFFNESS, y: (target.y - grab.y) * DRAG_STIFFNESS };
    const ds = Math.hypot(desired.x, desired.y);
    if (ds > MAX_DRAG_SPEED) desired = { x: (desired.x / ds) * MAX_DRAG_SPEED, y: (desired.y / ds) * MAX_DRAG_SPEED };
    const k = body.mass() * dragGain(body.mass());
    body.applyImpulseAtPoint({ x: (desired.x - pointVel.x) * k, y: (desired.y - pointVel.y) * k }, grab, true);
  }

  private updateFloors(): void {
    for (const rec of this.recs.values()) {
      if (!rec.floorActive) continue;
      const t = rec.body.translation();
      const liftedOff = rec.floorY - (t.y + rec.bottomOffset) > rec.halfHeight;
      const leftSpan = t.x < rec.floorX1 || t.x > rec.floorX2;
      // The bodies it stood on were pulled away: it falls.
      const below = { x: (rec.floorX1 + rec.floorX2) / 2, y: rec.floorY + 1 / this.ppm };
      const unsupported = rec.supporters.length > 0 && !rec.supporters.some((s) => s.colliders.some((c) => c.containsPoint(below)));
      // Permanent: a thrown or carried-away object lands on the global floor from now on.
      if (liftedOff || leftSpan || unsupported) {
        rec.floorActive = false;
        rec.body.wakeUp(); // a body resting on its floor may be asleep
      }
    }
  }

  private updateExemptions(): void {
    for (const [key, pair] of this.exempt) {
      pair.clearSteps = this.partsIntersect(pair.a, pair.b) ? 0 : pair.clearSteps + 1;
      if (pair.clearSteps >= OVERLAP_CLEAR_STEPS) this.exempt.delete(key);
    }
  }

  private ownerOf(handle: number): string {
    // Own floors, the global floor and the walls all sound like the ground.
    return this.colliderOwner.get(handle) ?? GROUND;
  }

  step(): CollisionEvent[] {
    this.applyPendingPatches();
    this.applyDrag();
    const dt = DT * this.timeScale;
    for (const rule of this.rules) {
      rule.stepMs = 0;
      rule.ticks++;
      rule.ageS += dt;
    }
    this.dispatch('onStep', dt);
    // Impact speed must be measured before the solver resolves the contact.
    for (const rec of this.recs.values()) {
      if (!rec.dynamic) continue;
      const v = rec.body.linvel();
      this.preStepVel.set(rec.id, { x: v.x, y: v.y });
    }
    this.world.step(this.eventQueue, this.hooks);
    this.stepCount++;
    this.updateFloors();
    this.updateExemptions();

    const events: CollisionEvent[] = [];
    this.eventQueue.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      let a = this.ownerOf(h1);
      let b = this.ownerOf(h2);
      if (a === GROUND) [a, b] = [b, a];
      if (a === GROUND || a === b) return;
      const ra = this.recs.get(a)!;
      const rb = b === GROUND ? null : this.recs.get(b)!;
      const va = this.preStepVel.get(a) ?? { x: 0, y: 0 };
      const vb = (rb && this.preStepVel.get(b)) || { x: 0, y: 0 };
      const speed = Math.hypot(va.x - vb.x, va.y - vb.y);
      if (speed < MIN_IMPACT_SPEED) return;
      const key = pairKey(a, b);
      if (this.stepCount - (this.lastImpact.get(key) ?? -Infinity) < IMPACT_COOLDOWN_STEPS) return;
      this.lastImpact.set(key, this.stepCount);
      events.push({
        a,
        b,
        speed_mps: speed,
        material_a: ra.material,
        material_b: rb ? rb.material : this.manifest.ground_material,
        mass_a: ra.massKg,
      });
    });
    for (const e of events) this.dispatch('onCollision', Object.freeze({ a: e.a, b: e.b, speed: e.speed_mps }));
    for (const rule of [...this.rules]) {
      rule.slowSteps = rule.stepMs > SLOW_HOOK_MS ? rule.slowSteps + 1 : 0;
      if (rule.slowSteps >= SLOW_HOOK_STEPS) this.failRule(rule, `its hooks took over ${SLOW_HOOK_MS} ms per step for ${SLOW_HOOK_STEPS} steps`);
    }
    return events;
  }

  // ------------------------------------------------------------ rules (design: Rule semantics)

  /**
   * Load a preset or plugin. Rules whose declared writes overlap it are unloaded first; a 4th
   * plugin evicts the oldest. Returns whether the rule is active afterwards (a plugin that fails
   * to compile or throws in onInit is not). Details arrive through takeRuleEvents().
   */
  loadRule(def: RuleDef): boolean {
    const declared = def.kind === 'preset' ? this.presetDeclared(def) : [...def.writes];
    for (const r of [...this.rules]) {
      if (r.def.id === def.id) {
        this.dropRule(r); // the same preset again: reload it quietly
      } else if (writeSetsConflict(declared, r.declared)) {
        this.dropRule(r);
        this.ruleEvents.push({ kind: 'replaced', rule: r.def.id, name: r.def.name, detail: def.name });
      }
    }
    if (def.kind === 'plugin') {
      const plugins = this.rules.filter((r) => r.def.kind === 'plugin');
      if (plugins.length >= MAX_PLUGINS) {
        this.dropRule(plugins[0]);
        this.ruleEvents.push({ kind: 'evicted', rule: plugins[0].def.id, name: plugins[0].def.name, detail: def.name });
      }
    }
    const rule: ActiveRule = { def, declared, hooks: {}, ticks: 0, ageS: 0, stepMs: 0, slowSteps: 0 };
    this.rules.push(rule);
    if (def.kind === 'preset') {
      for (const [key, value] of this.presetWrites(def)) this.write(rule, key, value);
      if (def.float) this.floatOff(this.presetTargets(def), def.float);
      this.ruleEvents.push({ kind: 'loaded', rule: def.id, name: def.name, detail: '' });
      return true;
    }
    try {
      rule.hooks = compilePlugin(def.source, this.makeCtx(rule), this.random);
    } catch (e) {
      this.failRule(rule, (e as Error).message);
      return false;
    }
    this.ruleEvents.push({ kind: 'loaded', rule: def.id, name: def.name, detail: '' });
    this.runHook(rule, 'onInit', []);
    return this.rules.includes(rule);
  }

  unloadRule(id: string, reason = 'removed'): void {
    const rule = this.rules.find((r) => r.def.id === id);
    if (!rule) return;
    this.dropRule(rule);
    this.ruleEvents.push({ kind: 'unloaded', rule: id, name: rule.def.name, detail: reason });
  }

  /** "reset": unload every rule; fields fall back to grounded physics. */
  resetRules(): void {
    for (const r of [...this.rules]) this.unloadRule(r.def.id, 'reset');
  }

  ruleInfos(): RuleInfo[] {
    return this.rules.map((r) => ({ id: r.def.id, kind: r.def.kind, name: r.def.name, writes: r.declared }));
  }

  hasRule(id: string): boolean {
    return this.rules.some((r) => r.def.id === id);
  }

  takeRuleEvents(): RuleEvent[] {
    const out = this.ruleEvents;
    this.ruleEvents = [];
    return out;
  }

  takeLogs(): string[] {
    const out = this.logs;
    this.logs = [];
    return out;
  }

  /** Effective value of a stackable field (rule entry, else base). */
  fieldValue(key: FieldKey): FieldValue | undefined {
    return this.stack.effective(key);
  }

  /**
   * Zero gravity: lift everything off its floor with a gentle random drift and spin. Speeds are in
   * on-screen pixels per second, so a close-up desk and a street float at the same pace.
   */
  private floatOff(ids: string[], n: FloatNudge): void {
    if (this.replaying) return;
    const k = 1 / this.ppm;
    for (const id of ids) {
      const rec = this.recs.get(id);
      if (!rec?.dynamic || this.held?.rec === rec) continue;
      rec.floorActive = false;
      const v = rec.body.linvel();
      const up = (n.up_pxps[0] + this.random() * (n.up_pxps[1] - n.up_pxps[0])) * k;
      rec.body.setLinvel({ x: v.x + (this.random() * 2 - 1) * n.side_pxps * k, y: v.y - up }, true);
      rec.body.setAngvel(rec.body.angvel() + (this.random() * 2 - 1) * n.spin_radps, true);
    }
  }

  private presetTargets(def: Extract<RuleDef, { kind: 'preset' }>): string[] {
    return def.targets ?? this.ids.filter((id) => this.recs.get(id)!.dynamic);
  }

  private presetDeclared(def: Extract<RuleDef, { kind: 'preset' }>): string[] {
    return def.writes.flatMap((w) =>
      w.field.startsWith('entity:*.') && def.targets ? def.targets.map((id) => entityKey(id, w.field.slice(9))) : [w.field],
    );
  }

  private presetWrites(def: Extract<RuleDef, { kind: 'preset' }>): [FieldKey, FieldValue][] {
    return def.writes.flatMap((w: PresetWrite): [FieldKey, FieldValue][] =>
      w.field.startsWith('entity:*.') ? this.presetTargets(def).map((id) => [entityKey(id, w.field.slice(9)), w.value]) : [[w.field, w.value]],
    );
  }

  private dropRule(rule: ActiveRule): void {
    const i = this.rules.indexOf(rule);
    if (i < 0) return;
    this.rules.splice(i, 1);
    for (const key of this.stack.pop(rule.def.id)) this.applyField(key);
  }

  private failRule(rule: ActiveRule, reason: string): void {
    this.dropRule(rule);
    this.ruleEvents.push({ kind: 'failed', rule: rule.def.id, name: rule.def.name, detail: reason });
  }

  /** Run one hook of every plugin (oldest first) under the per-hook guard. */
  private dispatch(name: HookName, ...args: unknown[]): void {
    for (const rule of [...this.rules]) if (rule.hooks[name]) this.runHook(rule, name, args);
  }

  private runHook(rule: ActiveRule, name: HookName, args: unknown[]): void {
    const fn = rule.hooks[name];
    if (!fn || !this.rules.includes(rule)) return;
    this.running = rule.def.id;
    this.onHookEnter?.(rule.def.id);
    const t0 = performance.now();
    try {
      fn.apply(undefined, args);
    } catch (e) {
      this.running = null;
      this.failRule(rule, `${name} threw: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.running = null;
    rule.stepMs += performance.now() - t0;
  }

  /** The only way a rule changes a stackable field. */
  private write(rule: ActiveRule, key: FieldKey, value: FieldValue): void {
    if (!isDeclared(rule.declared, key)) throw new Error(`wrote ${key} without declaring it in writes`);
    this.stack.push(rule.def.id, key, value);
    this.applyField(key);
  }

  /** Push a field's effective value into Rapier. */
  private applyField(key: FieldKey): void {
    const v = this.stack.effective(key);
    if (v === undefined) return;
    if (key === 'world.gravity') {
      const [x, y] = v as [number, number];
      this.world.gravity = { x, y };
      this.ceiling.setEnabled(y < CEILING_BELOW_GRAVITY);
      for (const rec of this.recs.values()) if (rec.dynamic) rec.body.wakeUp();
      return;
    }
    if (key === 'world.time_scale') {
      this.timeScale = v as number;
      this.world.timestep = DT * this.timeScale;
      return;
    }
    const p = parseWrite(key);
    const rec = p && this.recs.get(p.id);
    if (!p || !rec) return;
    switch (p.field) {
      case 'mass':
        rec.rawMassKg = v as number;
        if (rec.dynamic) this.rebalanceMasses();
        break;
      case 'restitution':
        for (const c of rec.colliders) c.setRestitution(v as number);
        break;
      case 'friction':
        for (const c of rec.colliders) c.setFriction(v as number);
        break;
      case 'damping':
        rec.body.setLinearDamping(v as number);
        break;
      case 'body_type':
        this.setDynamic(rec, v === 'dynamic');
        break;
    }
    rec.body.wakeUp();
  }

  private setDynamic(rec: BodyRec, dynamic: boolean): void {
    if (rec.dynamic === dynamic) return;
    if (!dynamic && this.held?.rec === rec) this.held = null;
    rec.body.setBodyType(dynamic ? RAPIER.RigidBodyType.Dynamic : RAPIER.RigidBodyType.Fixed, true);
    rec.dynamic = dynamic;
    if (!dynamic) rec.massKg = 0;
    this.rebalanceMasses();
  }

  entityView(id: string): EntityView | null {
    const rec = this.recs.get(id);
    if (!rec) return null;
    const t = rec.body.translation();
    const v = rec.body.linvel();
    return Object.freeze({
      id,
      label: rec.spec.label,
      x: t.x,
      y: t.y,
      vx: v.x,
      vy: v.y,
      speed: Math.hypot(v.x, v.y),
      angle: rec.body.rotation(),
      angularVelocity: rec.body.angvel(),
      mass: this.stack.effective(entityKey(id, 'mass')) as number,
      restitution: this.stack.effective(entityKey(id, 'restitution')) as number,
      friction: this.stack.effective(entityKey(id, 'friction')) as number,
      dynamic: rec.dynamic,
      held: this.held?.rec === rec,
      width: rec.widthM,
      height: rec.halfHeight * 2,
    });
  }

  /** Teleport a body (verifier collision scenarios). Meters and m/s. */
  setPose(id: string, x: number, y: number, vx: number, vy: number): void {
    const rec = this.recs.get(id);
    if (!rec) return;
    rec.body.setTranslation({ x, y }, true);
    rec.body.setLinvel({ x: vx, y: vy }, true);
    rec.body.setAngvel(0, true);
    this.world.propagateModifiedBodyPositionsToColliders();
  }

  get gravity(): { x: number; y: number } {
    const g = this.world.gravity;
    return { x: g.x, y: g.y };
  }

  get currentTimeScale(): number {
    return this.timeScale;
  }

  get bounds(): { width: number; height: number } {
    return { width: this.manifest.resolution.width / this.ppm, height: this.manifest.resolution.height / this.ppm };
  }

  /** The plugin API (shared/ctx.d.ts), bound to one rule so every write is attributed to it. */
  private makeCtx(rule: ActiveRule): object {
    const bindings = (rule.def as { bindings?: Bindings }).bindings ?? { thisId: null, thatId: null, named: [] };
    const entity = (id: unknown): BodyRec => {
      const rec = this.recs.get(String(id));
      if (!rec) throw new Error(`no entity "${String(id)}" (ids: ${this.ids.join(', ')})`);
      return rec;
    };
    const set = (id: unknown, field: string, value: FieldValue) => this.write(rule, entityKey(entity(id).id, field), value);
    const moving = (id: unknown): BodyRec | null => {
      const rec = entity(id);
      const key = entityKey(rec.id, 'velocity');
      if (!isDeclared(rule.declared, key)) throw new Error(`moved ${rec.id} without declaring ${key} in writes`);
      return rec.dynamic ? rec : null;
    };
    const bounds = Object.freeze(this.bounds);
    const api = {
      entities: () => [...this.ids],
      entity: (id: unknown) => this.entityView(String(id)),
      find: (word: unknown) => {
        const w = String(word).toLowerCase();
        return this.ids.filter((id) => this.recs.get(id)!.spec.label.toLowerCase().includes(w) || id.includes(w));
      },
      bindings: Object.freeze({ thisId: bindings.thisId, thatId: bindings.thatId, named: Object.freeze([...bindings.named]) }),
      time: () => rule.ageS,
      tick: () => rule.ticks,
      random: this.random,
      bounds,
      setGravity: (x: unknown, y: unknown) => this.write(rule, 'world.gravity', [finite(x, 'gravity x'), finite(y, 'gravity y')]),
      gravity: () => Object.freeze(this.gravity),
      setTimeScale: (s: unknown) => this.write(rule, 'world.time_scale', clamp(finite(s, 'time scale'), 0.05, 4)),
      setMass: (id: unknown, kg: unknown) => set(id, 'mass', clamp(finite(kg, 'mass'), 0.001, 100000)),
      setRestitution: (id: unknown, r: unknown) => set(id, 'restitution', clamp(finite(r, 'restitution'), 0, 1.2)),
      setFriction: (id: unknown, f: unknown) => set(id, 'friction', clamp(finite(f, 'friction'), 0, 2)),
      setDamping: (id: unknown, d: unknown) => set(id, 'damping', clamp(finite(d, 'damping'), 0, 50)),
      setBodyType: (id: unknown, type: unknown) => {
        if (type !== 'dynamic' && type !== 'fixed') throw new Error(`body type must be "dynamic" or "fixed", got ${String(type)}`);
        set(id, 'body_type', type);
      },
      applyImpulse: (id: unknown, ix: unknown, iy: unknown) => {
        const rec = moving(id);
        const imp = { x: finite(ix, 'impulse x'), y: finite(iy, 'impulse y') };
        if (!rec) return;
        // Plugins think in real kg (ctx.entity().mass); the body carries the compressed mass
        // (OV7). Scale so that impulse = mass * dv changes the speed by exactly dv.
        const s = rec.rawMassKg > 0 ? rec.massKg / rec.rawMassKg : 1;
        rec.body.applyImpulse({ x: imp.x * s, y: imp.y * s }, true);
      },
      setVelocity: (id: unknown, vx: unknown, vy: unknown) => {
        const rec = moving(id);
        const v = { x: finite(vx, 'velocity x'), y: finite(vy, 'velocity y') };
        rec?.body.setLinvel(v, true);
      },
      setAngularVelocity: (id: unknown, w: unknown) => {
        const rec = moving(id);
        const av = finite(w, 'angular velocity');
        rec?.body.setAngvel(av, true);
      },
      freeze: <T>(value: T): T => Object.freeze(value),
      log: (...parts: unknown[]) => {
        this.logs.push(`${rule.def.name}: ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`);
        if (this.logs.length > MAX_LOG_LINES) this.logs.shift();
      },
    };
    return Object.freeze(Object.assign(Object.create(null), api));
  }

  // ------------------------------------------------------------ output

  /** Fill `out` (length ids.length * STRIDE) with pixel-space poses and velocities. */
  writeFrame(out: Float32Array): void {
    const ppm = this.ppm;
    const heldId = this.heldId;
    this.ids.forEach((id, i) => {
      const rec = this.recs.get(id)!;
      const t = rec.body.translation();
      const v = rec.body.linvel();
      const o = i * STRIDE;
      out[o] = t.x * ppm;
      out[o + 1] = t.y * ppm;
      out[o + 2] = rec.body.rotation();
      out[o + 3] = v.x * ppm;
      out[o + 4] = v.y * ppm;
      out[o + 5] = (rec.floorActive ? FLAG_FLOOR_ACTIVE : 0) | (heldId === id ? FLAG_HELD : 0);
    });
  }

  geometry(): EntityGeometry[] {
    return this.ids.map((id) => this.geometryOf(this.recs.get(id)!));
  }

  private geometryOf(rec: BodyRec): EntityGeometry {
    return {
      id: rec.id,
      label: rec.spec.label,
      dynamic: rec.dynamic,
      mass_kg: rec.massKg,
      material: rec.material,
      centroid_px: rec.centroidPx,
      parts_local_px: rec.partsLocalPx,
      floor_px: rec.dynamic ? { y: rec.floorY * this.ppm, x1: rec.floorX1 * this.ppm, x2: rec.floorX2 * this.ppm } : null,
    };
  }

  labelOf(id: string): string | undefined {
    return this.recs.get(id)?.spec.label;
  }

  isDynamic(id: string): boolean {
    return this.recs.get(id)?.dynamic ?? false;
  }

  /** Pose of one entity in pixels (tests and debugging). */
  pose(id: string): { x: number; y: number; rot: number; vx: number; vy: number } {
    const rec = this.recs.get(id)!;
    const t = rec.body.translation();
    const v = rec.body.linvel();
    return { x: t.x * this.ppm, y: t.y * this.ppm, rot: rec.body.rotation(), vx: v.x * this.ppm, vy: v.y * this.ppm };
  }

  massOf(id: string): number {
    return this.recs.get(id)?.massKg ?? 0;
  }

  free(): void {
    this.eventQueue.free();
    this.world.free();
  }
}
