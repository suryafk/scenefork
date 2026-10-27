// Physics world shared by the live PhysicsWorker and (Phase 3) the verifier worker (eng review D2).
// Pure: no Pixi, no DOM. Rapier runs in meters; pixels only cross this boundary through
// `pixels_per_meter`.
import RAPIER from '@dimforge/rapier2d-compat';
import { boundingBox, compressMasses, polygonArea, polygonCentroid, toConvexParts } from './geometry';
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
/** Steps a spawn-overlapping pair must stay apart before it collides normally. */
const OVERLAP_CLEAR_STEPS = 10;
const MIN_IMPACT_SPEED = 0.8;
const IMPACT_COOLDOWN_STEPS = 5;
const GROUND = 'ground';

/**
 * Fraction of the velocity error the drag corrects per step. The impulse is
 * mass * gain = mass^0.6 * 0.9 (OV7), capped at 0.9 so light objects don't overshoot:
 * a 500 kg truck visibly lags the cursor, a 2 kg ball snaps to it.
 */
export function dragGain(massKg: number): number {
  return Math.min(0.9, 0.9 * Math.pow(Math.max(massKg, 1e-3), -0.4));
}

interface BodyRec {
  id: string;
  spec: EntitySpec;
  body: RAPIER.RigidBody;
  colliders: RAPIER.Collider[];
  dynamic: boolean;
  massKg: number;
  /** Mass before compression; grounding replaces it. */
  rawMassKg: number;
  /** Each part collider's share of the body's area, for splitting mass. */
  areaFractions: number[];
  material: AcousticMaterial;
  centroidPx: Point;
  partsLocalPx: Point[][];
  floor: RAPIER.Collider | null;
  floorActive: boolean;
  floorY: number;
  floorX1: number;
  floorX2: number;
  /** Distance from the body origin down to its lowest point at spawn, in meters. */
  bottomOffset: number;
  halfHeight: number;
}

interface Held {
  rec: BodyRec;
  /** Grab point in body-local meters. */
  local: { x: number; y: number };
  target: { x: number; y: number };
}

const rotate = (v: { x: number; y: number }, a: number) => ({
  x: v.x * Math.cos(a) - v.y * Math.sin(a),
  y: v.x * Math.sin(a) + v.y * Math.cos(a),
});
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

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
  private held: Held | null = null;
  private stepCount = 0;
  /** Grounding results waiting for their body to come to rest (design step 5). */
  private readonly pendingPatches = new Map<string, Grounding>();

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
  constructor(manifest: SceneManifest) {
    this.manifest = manifest;
    this.ppm = manifest.pixels_per_meter;
    this.world = new RAPIER.World({ x: 0, y: manifest.gravity_mps2 });
    this.world.numSolverIterations = 8;
    this.eventQueue = new RAPIER.EventQueue(true);
    this.ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.buildBounds();

    for (const spec of manifest.entities) this.buildEntity(spec);
    // Collider poses are only written during a step; shape tests at spawn need them now.
    this.world.propagateModifiedBodyPositionsToColliders();
    this.findSpawnOverlaps();
    this.rebalanceMasses();
    for (const rec of this.recs.values()) if (rec.dynamic) this.buildOwnFloor(rec);
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
      rec.spec = { ...rec.spec, label: g.label, acoustic_material: g.acoustic_material };
      rec.material = g.acoustic_material;
      for (const c of rec.colliders) {
        c.setRestitution(g.restitution);
        c.setFriction(g.friction);
      }
      if (!rec.dynamic) continue;
      if (g.body_type === 'fixed') {
        // A wall or pole the user freed by mistake stops moving, at rest where it is.
        rec.body.setBodyType(RAPIER.RigidBodyType.Fixed, false);
        rec.dynamic = false;
        rec.floorActive = false;
        rec.massKg = 0;
        this.rebalanceMasses();
      } else {
        rec.rawMassKg = g.mass_kg;
        this.rebalanceMasses();
      }
    }
  }

  private buildBounds(): void {
    const w = this.manifest.resolution.width / this.ppm;
    const h = this.manifest.resolution.height / this.ppm;
    const add = (desc: RAPIER.ColliderDesc) => {
      const c = this.world.createCollider(desc.setFriction(0.8).setRestitution(0.15), this.ground);
      this.colliderOwner.set(c.handle, GROUND);
    };
    // Global floor: top face on the frame's bottom edge. Walls reach well above the frame
    // so thrown objects come back down instead of leaving the scene.
    add(RAPIER.ColliderDesc.cuboid(w / 2 + 2, 1).setTranslation(w / 2, h + 1));
    add(RAPIER.ColliderDesc.cuboid(1, h * 3).setTranslation(-1, 0));
    add(RAPIER.ColliderDesc.cuboid(1, h * 3).setTranslation(w + 1, 0));
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
      rawMassKg: dynamic ? spec.physics.mass_kg : 0,
      areaFractions,
      material: spec.acoustic_material,
      centroidPx: centroid,
      partsLocalPx,
      floor: null,
      floorActive: false,
      floorY: (maxY + 1) / ppm,
      floorX1: (centroid[0] - 0.75 * bb.w) / ppm,
      floorX2: (centroid[0] + 0.75 * bb.w) / ppm,
      bottomOffset: (maxY - centroid[1]) / ppm,
      halfHeight: bb.h / 2 / ppm,
    };
    this.recs.set(spec.id, rec);
    this.ids.push(spec.id);
    return rec;
  }

  private buildOwnFloor(rec: BodyRec): void {
    // An object resting on another dynamic object (a bottle on a crate) gets no own floor:
    // its supporter holds it up, so it falls when the supporter is pulled away. A pair that
    // overlaps on screen is one object in front of another, not support.
    // Tested against where the other bodies are now, not where they were painted, since
    // objects freed later can land on (or next to) ones already moved.
    const t = rec.body.translation();
    const below = { x: t.x, y: t.y + rec.bottomOffset + 2 / this.ppm };
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
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
        .setActiveHooks(RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS),
      this.ground,
    );
    rec.floor = floor;
    rec.floorActive = true;
    this.floorOwner.set(floor.handle, rec.id);
  }

  private configurePart(desc: RAPIER.ColliderDesc, spec: EntitySpec): void {
    desc
      .setRestitution(spec.physics.restitution)
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
    if (!rec) return null;
    const t = rec.body.translation();
    this.held = { rec, local: rotate({ x: p.x - t.x, y: p.y - t.y }, -rec.body.rotation()), target: p };
    rec.body.setAngularDamping(HELD_ANGULAR_DAMPING);
    rec.body.wakeUp();
    return rec.id;
  }

  drag(xPx: number, yPx: number): void {
    if (this.held) this.held.target = { x: xPx / this.ppm, y: yPx / this.ppm };
  }

  release(): void {
    if (!this.held) return;
    const body = this.held.rec.body;
    body.setAngularDamping(0);
    const v = body.linvel();
    const speed = Math.hypot(v.x, v.y);
    if (speed > MAX_THROW_SPEED) body.setLinvel({ x: (v.x / speed) * MAX_THROW_SPEED, y: (v.y / speed) * MAX_THROW_SPEED }, true);
    this.held = null;
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
      // Permanent: a thrown or carried-away object lands on the global floor from now on.
      if (liftedOff || leftSpan) rec.floorActive = false;
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
    return events;
  }

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
