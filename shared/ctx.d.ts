// The plugin API (design: Mutator contract). One copy, shared by the MutatorAgent prompt
// (embedded verbatim), the PhysicsWorker runtime and the verifier. A contract test fails if
// SimCore's ctx keys drift from the `Ctx` interface below.
//
// Units: meters, seconds, kg. +x is right, +y is DOWN (screen space), so normal gravity is
// (0, 9.81) and "gravity up" is (0, -9.81). Angles are radians, clockwise positive.
//
// A plugin is the BODY of `function (ctx) { ... }` in strict mode. It must `return` an object
// of hooks; every hook is optional:
//
//   return {
//     onInit() {},                  // once, when the rule loads
//     onStep(dt) {},                // every physics step (dt = 1/60 s, already time-scaled)
//     onCollision(e) {},            // e: CollisionInfo, for each new impact
//     onGrab(id) {},                // the user picked up entity `id`
//     onRelease(id) {},             // the user let go of entity `id` (after a drag)
//   };
//
// Free names allowed: ctx, Math, Number, Infinity, NaN, isFinite, isNaN, parseFloat, parseInt,
// JSON, plus names the plugin declares itself. Not allowed: this, arguments, undefined (use
// `x == null`), Object, Array statics, computed member access except numeric literals (`a[0]`
// is fine, `a[i]` is not: use for...of or array methods), async/await, import, with, and the
// property names constructor, __proto__, prototype.
//
// Every write through ctx must be declared in the plugin's `writes` list (see the plugin
// schema). Writing an undeclared field unloads the plugin. Non-finite numbers throw.

export type EntityId = string;

export interface EntityView {
  readonly id: EntityId;
  readonly label: string;
  /** Center of mass, meters. */
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  /** |velocity|, m/s. */
  readonly speed: number;
  readonly angle: number;
  readonly angularVelocity: number;
  /** Effective (stacked) values. */
  readonly mass: number;
  readonly restitution: number;
  readonly friction: number;
  readonly dynamic: boolean;
  /** The user is dragging it right now. */
  readonly held: boolean;
  /** Approximate size of the body, meters. */
  readonly width: number;
  readonly height: number;
}

export interface CollisionInfo {
  readonly a: EntityId;
  /** Entity id, or "ground" for floors and walls. */
  readonly b: EntityId;
  /** Relative speed at impact, m/s. */
  readonly speed: number;
}

export interface Bindings {
  /** Entity the user pointed at while saying "this" (longest pointer dwell), else null. */
  readonly thisId: EntityId | null;
  /** Second-longest dwell, for "that", else null. */
  readonly thatId: EntityId | null;
  /** Entities named in the command ("the truck"), matched by label. */
  readonly named: readonly EntityId[];
}

export interface Ctx {
  /** Ids of every body in the scene (fixed ones included). */
  entities(): EntityId[];
  /** Read-only snapshot of one body, or null if it doesn't exist. */
  entity(id: EntityId): EntityView | null;
  /** Ids whose label contains `word` (case-insensitive). */
  find(word: string): EntityId[];
  readonly bindings: Bindings;
  /** Seconds since this rule loaded (scaled by time_scale), and steps since it loaded. */
  time(): number;
  tick(): number;
  /** Seeded random number in [0, 1). Use this, not Math.random. */
  random(): number;
  /** World size in meters. */
  readonly bounds: { readonly width: number; readonly height: number };

  // Stackable fields: reverted automatically when the rule unloads.
  /** writes: "world.gravity" */
  setGravity(x: number, y: number): void;
  gravity(): { x: number; y: number };
  /** writes: "world.time_scale"; 1 is normal, 0.3 is slow motion. Range 0.05-4. */
  setTimeScale(scale: number): void;
  /** writes: "entity:<id>.mass" (kg) */
  setMass(id: EntityId, kg: number): void;
  /** writes: "entity:<id>.restitution" (0-1.2) */
  setRestitution(id: EntityId, r: number): void;
  /** writes: "entity:<id>.friction" (0-2) */
  setFriction(id: EntityId, f: number): void;
  /** writes: "entity:<id>.damping"; linear damping, 0 is none. */
  setDamping(id: EntityId, d: number): void;
  /** writes: "entity:<id>.body_type"; "fixed" pins a body in place. */
  setBodyType(id: EntityId, type: 'dynamic' | 'fixed'): void;

  // Motion: per-step, not reverted (bodies just settle). writes: "entity:<id>.velocity"
  applyImpulse(id: EntityId, ix: number, iy: number): void;
  setVelocity(id: EntityId, vx: number, vy: number): void;
  setAngularVelocity(id: EntityId, w: number): void;

  /** Freeze a plain object or array (instead of Object.freeze). */
  freeze<T>(value: T): T;
  /** Show a line in the HUD's mutator log. */
  log(...parts: unknown[]): void;
}
