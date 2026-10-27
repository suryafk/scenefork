// Scene contract and worker message protocol. Everything here is plain data so it
// crosses the worker boundary with structured clone.

export type AcousticMaterial =
  | 'hollow_metal'
  | 'solid_metal'
  | 'glass'
  | 'ceramic'
  | 'wood'
  | 'rubber'
  | 'plastic'
  | 'flesh_cloth'
  | 'concrete'
  | 'water';

export type Point = [number, number];

export interface EntitySpec {
  id: string;
  label: string;
  body_type: 'dynamic' | 'fixed';
  /** Outline in frame pixels (absolute), e.g. a simplified SAM mask contour. */
  polygon_px: Point[];
  physics: { mass_kg: number; restitution: number; friction: number };
  acoustic_material: AcousticMaterial;
  z_index: number;
}

export interface SceneManifest {
  scene_id: string;
  resolution: { width: number; height: number };
  /** Per clip (OV6): golden clips set it by hand, live forks derive it from grounding. */
  pixels_per_meter: number;
  gravity_mps2: number;
  ground_material: AcousticMaterial;
  entities: EntitySpec[];
}

/** Per-entity floats in each frame message. Positions and velocities are in frame pixels. */
export const STRIDE = 6;
export const Field = { X: 0, Y: 1, Rot: 2, Vx: 3, Vy: 4, Flags: 5 } as const;
export const FLAG_FLOOR_ACTIVE = 1;
export const FLAG_HELD = 2;

export interface CollisionEvent {
  a: string;
  /** Entity id, or "ground" for the global floor, walls and own floors. */
  b: string;
  speed_mps: number;
  material_a: AcousticMaterial;
  material_b: AcousticMaterial;
  mass_a: number;
}

/** Static geometry for rendering and the X-Ray HUD, in pixels. */
export interface EntityGeometry {
  id: string;
  label: string;
  dynamic: boolean;
  mass_kg: number;
  material: AcousticMaterial;
  /** Centroid in frame pixels at spawn: the body origin. */
  centroid_px: [number, number];
  /** Convex parts, vertices relative to the centroid. */
  parts_local_px: Point[][];
  /** Own floor segment in frame pixels, or null for fixed entities. */
  floor_px: { y: number; x1: number; x2: number } | null;
}

export type MainToWorker =
  | { type: 'init'; manifest: SceneManifest }
  | { type: 'pointer'; phase: 'down' | 'move' | 'up'; x: number; y: number };

export type WorkerToMain =
  | { type: 'ready'; ids: string[]; geometry: EntityGeometry[] }
  | {
      type: 'frame';
      buf: Float32Array;
      held: string | null;
      step_ms: number;
      collisions: CollisionEvent[];
    }
  | { type: 'error'; message: string };
