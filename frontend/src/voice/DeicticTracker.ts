// Pointer ring buffer for "this"/"that" (design: Voice). Samples which entity is under the
// pointer at 30 Hz for the last 15 s; an utterance asks for dwell time per entity over its
// window plus 500 ms before it.
const SAMPLE_MS = 1000 / 30;
const CAPACITY = 15 * 30;
export const LEAD_MS = 500;

export class DeicticTracker {
  private readonly samples: { t: number; id: string | null }[] = [];
  private pointer: [number, number] | null = null;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly hitTest: (x: number, y: number) => string | null) {
    this.timer = setInterval(() => this.sample(), SAMPLE_MS);
  }

  /** Latest pointer position in frame pixels, or null when it left the canvas. */
  move(p: [number, number] | null): void {
    this.pointer = p;
  }

  private sample(): void {
    this.samples.push({ t: performance.now(), id: this.pointer ? this.hitTest(this.pointer[0], this.pointer[1]) : null });
    if (this.samples.length > CAPACITY) this.samples.shift();
  }

  /** Milliseconds the pointer spent on each entity between `from - LEAD_MS` and `to`. */
  dwell(from: number, to = performance.now()): [string, number][] {
    const totals = new Map<string, number>();
    for (const s of this.samples) {
      if (s.id && s.t >= from - LEAD_MS && s.t <= to) totals.set(s.id, (totals.get(s.id) ?? 0) + SAMPLE_MS);
    }
    return [...totals].sort((a, b) => b[1] - a[1]);
  }

  dispose(): void {
    clearInterval(this.timer);
  }
}
