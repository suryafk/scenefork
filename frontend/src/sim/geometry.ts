import { decomp, isSimple, makeCCW, quickDecomp, removeCollinearPoints, removeDuplicatePoints } from 'poly-decomp-es';
import type { Point } from './types';

const MAX_PARTS = 4;

export function polygonArea(poly: Point[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/** Area-weighted centroid: the center of mass of a uniform-density polygon. */
export function polygonCentroid(poly: Point[]): Point {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    const cross = x1 * y2 - x2 * y1;
    a += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  if (Math.abs(a) < 1e-9) {
    const n = poly.length;
    return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/** Andrew's monotone chain. Returns the hull without repeating the first point. */
export function convexHull(points: Point[]): Point[] {
  const pts = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  if (pts.length < 3) return pts;
  const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/**
 * Split an outline into 1-4 convex parts for Rapier. Concave masks (a truck's cab step)
 * keep their shape; anything messier falls back to a single convex hull.
 */
export function toConvexParts(poly: Point[]): Point[][] {
  const work: Point[] = poly.map(([x, y]) => [x, y]);
  removeDuplicatePoints(work, 0.5);
  removeCollinearPoints(work, 0.01);
  if (work.length < 3) return [convexHull(poly)];
  makeCCW(work);
  if (!isSimple(work)) return [convexHull(poly)];
  const hull = convexHull(work);
  // Already convex: one part.
  if (hull.length === work.length) return [hull];
  let parts = quickDecomp(work);
  if (!parts.length || parts.length > MAX_PARTS) {
    const exact = decomp(work);
    parts = exact && exact.length <= MAX_PARTS ? exact : [];
  }
  if (!parts.length) return [hull];
  return parts.map((p) => convexHull(p)).filter((p) => p.length >= 3);
}

/** Sprite anchor that puts the texture's centroid on the body origin. */
export function spriteAnchor(centroid: Point, bbox: { x: number; y: number; w: number; h: number }): Point {
  return [(centroid[0] - bbox.x) / bbox.w, (centroid[1] - bbox.y) / bbox.h];
}

export function boundingBox(poly: Point[]): { x: number; y: number; w: number; h: number } {
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/**
 * Compress masses in log space so the heaviest/lightest ratio is at most `maxRatio` (OV7),
 * keeping their order. Extreme ratios (a 2500 kg truck against a 0.5 kg bottle) make the
 * contact solver jitter.
 */
export function compressMasses(masses: number[], maxRatio = 200): number[] {
  if (masses.length < 2) return [...masses];
  const lo = Math.min(...masses);
  const hi = Math.max(...masses);
  if (hi / lo <= maxRatio) return [...masses];
  const mid = Math.sqrt(hi * lo);
  const s = Math.log(maxRatio) / Math.log(hi / lo);
  return masses.map((m) => mid * Math.exp(Math.log(m / mid) * s));
}

/** Even-odd ray casting. */
export function pointInPolygon([px, py]: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
