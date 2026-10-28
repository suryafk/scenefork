// Rule semantics (design: Rule semantics, eng review OV8). Presets and plugins are both rules.
// Every stackable field keeps a stack of (rule_id, value); its effective value is the newest
// remaining entry, else the base (grounded or default) value. Unloading a rule pops its
// entries, which restores each field correctly whatever order rules came and went in.
//
//   push(r1, gravity, moon)   push(r2, gravity, zero)   pop(r1)          pop(r2)
//   [moon]          → moon   [moon, zero]   → zero      [zero]  → zero   []   → base
import presetTable from '../../../shared/presets.json';

export type FieldValue = number | [number, number] | 'dynamic' | 'fixed';

/** world.gravity, world.time_scale, entity:<id>.<field> (stackable) or entity:<id>.velocity. */
export type FieldKey = string;

export const ENTITY_FIELDS = ['mass', 'restitution', 'friction', 'damping', 'body_type', 'velocity'] as const;
export type EntityField = (typeof ENTITY_FIELDS)[number];

export interface ParsedWrite {
  scope: 'world' | 'entity';
  /** Entity id, '*' for any entity, '' for world fields. */
  id: string;
  field: string;
}

const WRITE_RE = /^(world)\.(gravity|time_scale)$|^entity:([a-z0-9_]+|\*)\.(mass|restitution|friction|damping|body_type|velocity)$/;

export function parseWrite(w: string): ParsedWrite | null {
  const m = WRITE_RE.exec(w);
  if (!m) return null;
  return m[1] ? { scope: 'world', id: '', field: m[2] } : { scope: 'entity', id: m[3], field: m[4] };
}

/** Two declared writes touch the same field (a wildcard id overlaps every id). */
export function writesOverlap(a: string, b: string): boolean {
  const pa = parseWrite(a);
  const pb = parseWrite(b);
  if (!pa || !pb || pa.scope !== pb.scope || pa.field !== pb.field) return false;
  return pa.scope === 'world' || pa.id === '*' || pb.id === '*' || pa.id === pb.id;
}

export function writeSetsConflict(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.some((y) => writesOverlap(x, y)));
}

export function isDeclared(declared: readonly string[], key: FieldKey): boolean {
  return declared.some((d) => writesOverlap(d, key));
}

// ---------------------------------------------------------------- the stack

interface Entry {
  rule: string;
  value: FieldValue;
}

export interface StackSnapshot {
  base: [FieldKey, FieldValue][];
  stacks: [FieldKey, Entry[]][];
}

export class RuleStack {
  private readonly base = new Map<FieldKey, FieldValue>();
  private readonly stacks = new Map<FieldKey, Entry[]>();

  setBase(key: FieldKey, value: FieldValue): void {
    this.base.set(key, value);
  }

  getBase(key: FieldKey): FieldValue | undefined {
    return this.base.get(key);
  }

  /** A rule writing a field again replaces its own entry and moves it to the top. */
  push(rule: string, key: FieldKey, value: FieldValue): void {
    const stack = (this.stacks.get(key) ?? []).filter((e) => e.rule !== rule);
    stack.push({ rule, value });
    this.stacks.set(key, stack);
  }

  /** Remove every entry of a rule; returns the fields whose stacks changed. */
  pop(rule: string): FieldKey[] {
    const touched: FieldKey[] = [];
    for (const [key, stack] of this.stacks) {
      const kept = stack.filter((e) => e.rule !== rule);
      if (kept.length === stack.length) continue;
      touched.push(key);
      if (kept.length) this.stacks.set(key, kept);
      else this.stacks.delete(key);
    }
    return touched;
  }

  effective(key: FieldKey): FieldValue | undefined {
    const stack = this.stacks.get(key);
    return stack?.length ? stack[stack.length - 1].value : this.base.get(key);
  }

  /** Which rule currently decides a field, if any. */
  owner(key: FieldKey): string | null {
    const stack = this.stacks.get(key);
    return stack?.length ? stack[stack.length - 1].rule : null;
  }

  snapshot(): StackSnapshot {
    return {
      base: [...this.base],
      stacks: [...this.stacks].map(([k, s]) => [k, s.map((e) => ({ ...e }))]),
    };
  }
}

// ---------------------------------------------------------------- rule definitions

export interface PresetWrite {
  /** world.gravity, world.time_scale, or entity:*.<field> (expanded to the targets). */
  field: string;
  value: FieldValue;
}

export interface Preset {
  id: string;
  name: string;
  patterns: string[];
  keywords: string[];
  action?: 'reset';
  /** Presets with one-click buttons (Earth, Moon, Mars, Jupiter, Zero-G). */
  group?: 'gravity';
  /** Zero gravity: nudge every body so the scene floats off its floors. */
  float?: FloatNudge;
  writes: PresetWrite[];
}

export interface FloatNudge {
  /** Random upward speed range, in on-screen pixels per second. */
  up_pxps: [number, number];
  /** Random sideways speed, up to this, in pixels per second. */
  side_pxps: number;
  /** Random spin, up to this, rad/s. */
  spin_radps: number;
}

export const PRESETS: Preset[] = (presetTable as { presets: Preset[] }).presets;

/** Assertion and plugin shapes: shared/plugin.schema.json. */
export interface Scenario {
  kind: 'init' | 'ticks' | 'dragRelease' | 'collision';
  entity: string;
  other: string;
  drag_x_m: number;
  drag_y_m: number;
  n: number;
  rel_speed_mps: number;
}

export interface Assertion {
  scenario: Scenario;
  target: string;
  field: 'gravity_x' | 'gravity_y' | 'time_scale' | 'speed' | 'vx' | 'vy' | 'x' | 'y' | 'spin' | 'restitution' | 'mass' | 'friction' | 'alive';
  cmp: 'gt' | 'lt' | 'between' | 'changed_by_gt';
  value: number;
  value_max: number;
  at_tick: number;
}

export interface PluginDoc {
  feasible: boolean;
  reason: string;
  name: string;
  summary: string;
  writes: string[];
  source: string;
  assertions: Assertion[];
}

export interface Bindings {
  thisId: string | null;
  thatId: string | null;
  named: string[];
}

export const NO_BINDINGS: Bindings = { thisId: null, thatId: null, named: [] };

export type RuleDef =
  | { kind: 'preset'; id: string; name: string; presetId: string; writes: PresetWrite[]; targets: string[] | null; float?: FloatNudge }
  | { kind: 'plugin'; id: string; name: string; summary: string; writes: string[]; source: string; bindings: Bindings };

/** What the HUD shows for one active rule. */
export interface RuleInfo {
  id: string;
  kind: 'preset' | 'plugin';
  name: string;
  writes: string[];
}

export interface RuleEvent {
  kind: 'loaded' | 'replaced' | 'evicted' | 'unloaded' | 'failed';
  rule: string;
  name: string;
  /** For replaced/evicted: the rule that pushed it out. For failed/unloaded: why. */
  detail: string;
}

/** Plugins only: presets don't count toward the cap (design: Stacking). */
export const MAX_PLUGINS = 3;
