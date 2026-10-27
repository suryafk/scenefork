import { describe, expect, it } from 'vitest';
import { compressMasses, convexHull, pointInPolygon, polygonArea, polygonCentroid, spriteAnchor, toConvexParts } from './geometry';
import type { Point } from './types';

const truck: Point[] = [[380, 380], [610, 380], [610, 430], [700, 430], [700, 560], [380, 560]];

describe('polygon basics', () => {
  it('finds the area-weighted centroid, not the bounding-box center', () => {
    // L-shape: the centroid sits left of the bbox center because the cargo box is taller.
    const [cx, cy] = polygonCentroid(truck);
    expect(cx).toBeLessThan(540);
    expect(cy).toBeGreaterThan(470);
    expect(polygonCentroid([[0, 0], [10, 0], [10, 10], [0, 10]])).toEqual([5, 5]);
  });

  it('builds a convex hull that drops the concave corner', () => {
    const hull = convexHull(truck);
    expect(hull).toHaveLength(5);
    expect(hull).not.toContainEqual([610, 430]);
  });

  it('puts the sprite anchor on the centroid', () => {
    expect(spriteAnchor([540, 470], { x: 380, y: 380, w: 320, h: 180 })).toEqual([0.5, 0.5]);
    expect(spriteAnchor([400, 380], { x: 380, y: 380, w: 320, h: 180 })).toEqual([20 / 320, 0]);
  });

  it('tests points against a polygon', () => {
    expect(pointInPolygon([500, 500], truck)).toBe(true);
    expect(pointInPolygon([690, 400], truck)).toBe(false); // above the cab, in the concave notch
  });
});

describe('toConvexParts', () => {
  it('splits a concave outline into convex parts that keep its area', () => {
    const parts = toConvexParts(truck);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.length).toBeLessThanOrEqual(4);
    for (const p of parts) expect(convexHull(p)).toHaveLength(p.length);
    const total = parts.reduce((s, p) => s + polygonArea(p), 0);
    expect(total).toBeCloseTo(polygonArea(truck), 0);
  });

  it('keeps an already-convex outline as one part', () => {
    expect(toConvexParts([[0, 0], [50, 0], [50, 40], [0, 40]])).toHaveLength(1);
  });

  it('stays fast on a jagged 48-vertex outline (a worst-case SAM contour)', () => {
    const jagged: Point[] = Array.from({ length: 48 }, (_, i) => {
      const a = (i / 48) * Math.PI * 2;
      const r = i % 2 ? 120 : 70;
      return [Math.round(400 + r * Math.cos(a)), Math.round(300 + r * Math.sin(a))];
    });
    const t0 = performance.now();
    const parts = toConvexParts(jagged);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(parts.length).toBeGreaterThanOrEqual(1);
    expect(parts.length).toBeLessThanOrEqual(4);
  });

  it('falls back to the convex hull for a self-intersecting outline', () => {
    const bowtie: Point[] = [[0, 0], [40, 40], [40, 0], [0, 40]];
    expect(toConvexParts(bowtie)).toHaveLength(1);
  });
});

describe('compressMasses', () => {
  it('limits the heaviest/lightest ratio to 200 and keeps the order', () => {
    const out = compressMasses([2500, 3, 15, 0.5, 0.6, 20]);
    expect(Math.max(...out) / Math.min(...out)).toBeCloseTo(200, 6);
    const order = (xs: number[]) => xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
    expect(order(out)).toEqual(order([2500, 3, 15, 0.5, 0.6, 20]));
  });

  it('leaves masses alone when the ratio is already within bounds', () => {
    expect(compressMasses([10, 50, 900])).toEqual([10, 50, 900]);
  });
});
