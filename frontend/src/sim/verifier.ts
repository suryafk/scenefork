// Plugin verifier (design: Verifier, Assertion schema). Pure, so Vitest runs it headless and
// verifier.worker.ts runs it in a pre-warmed shadow worker that the main thread kills after
// 300 ms of silence.
//
// Order: static checks → every scenario with the plugin (assertions, stability, guards) →
// the same scenarios without it (baseline diff: at least one assertion must fail there, or
// the plugin is a no-op).
import { SimCore, type SimSnapshot } from './SimCore';
import { parseWrite, type Assertion, type Bindings, type PluginDoc, type RuleDef, type Scenario } from './rules';
import { checkPluginSource } from './sandbox';

export const MAX_SPEED_MPS = 200;
/** dragRelease: the pointer moves for this many steps, then holds still, then lets go. */
const DRAG_STEPS = 30;
const HOLD_STEPS = 20;
const ALIVE_MARGIN_M = 2;
const PROGRESS_EVERY = 30;

export type VerifyStage = 'static' | 'compile' | 'runtime' | 'stability' | 'assertions' | 'baseline';

export interface AssertionResult {
  index: number;
  pass: boolean;
  value: number;
  baselinePass: boolean | null;
  baselineValue: number | null;
}

export interface VerifyResult {
  ok: boolean;
  stage: VerifyStage | null;
  /** One line for the HUD and the repair prompt. */
  message: string;
  results: AssertionResult[];
  ms: number;
  logs: string[];
}

export interface VerifyRequest {
  snapshot: SimSnapshot;
  plugin: PluginDoc;
  bindings: Bindings;
  ruleId: string;
  seed: number;
}

const ENTITY_FIELDS = new Set(['speed', 'vx', 'vy', 'x', 'y', 'spin', 'restitution', 'mass', 'friction', 'alive']);
const WORLD_FIELDS = new Set(['gravity_x', 'gravity_y', 'time_scale']);

const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));

function describeScenario(s: Scenario): string {
  switch (s.kind) {
    case 'dragRelease':
      return `drag ${s.entity} by (${s.drag_x_m}, ${s.drag_y_m}) m and release`;
    case 'collision':
      return `${s.entity} hits ${s.other} at ${s.rel_speed_mps} m/s`;
    case 'ticks':
      return `${s.n} ticks`;
    default:
      return 'init';
  }
}

function expectation(a: Assertion): string {
  switch (a.cmp) {
    case 'gt':
      return `> ${a.value}`;
    case 'lt':
      return `< ${a.value}`;
    case 'between':
      return `between ${a.value} and ${a.value_max}`;
    case 'changed_by_gt':
      return `to change by more than ${a.value} from tick 0`;
  }
}

export function describeFailure(a: Assertion, index: number, value: number, baseline = false): string {
  return `assertion ${index + 1}${baseline ? ' (baseline)' : ''}: ${a.target} ${a.field} at tick ${a.at_tick} was ${fmt(value)}, expected ${expectation(a)} (${describeScenario(a.scenario)})`;
}

/** Checks that need no simulation. Returns a problem, or null. */
export function staticCheck(plugin: PluginDoc, snap: SimSnapshot, bindings: Bindings): string | null {
  if (!plugin.feasible) return `the agent said it can't do this: ${plugin.reason || 'no reason given'}`;
  if (!plugin.writes.length) return 'writes is empty: declare every field the plugin changes';
  for (const w of plugin.writes) if (!parseWrite(w)) return `bad write "${w}"`;
  const ids = new Map(snap.manifest.entities.map((e) => [e.id, e]));
  for (const w of plugin.writes) {
    const p = parseWrite(w)!;
    if (p.scope === 'entity' && p.id !== '*' && !ids.has(p.id)) return `writes names unknown entity "${p.id}"`;
  }
  if (!plugin.assertions.length) return 'no assertions: add at least one check of what the plugin does';
  const exists = (id: string) => ids.has(id);
  for (const [i, a] of plugin.assertions.entries()) {
    const n = i + 1;
    const ent = /^entity:(.+)$/.exec(a.target)?.[1];
    if (a.target === 'world' && !WORLD_FIELDS.has(a.field)) return `assertion ${n}: world has no field "${a.field}" (use gravity_x, gravity_y, time_scale)`;
    if (ent !== undefined && !ENTITY_FIELDS.has(a.field)) return `assertion ${n}: entities have no field "${a.field}"`;
    if (ent !== undefined && !exists(ent)) return `assertion ${n}: unknown entity "${ent}"`;
    if (a.at_tick < 0 || a.at_tick > 120) return `assertion ${n}: at_tick must be 0-120`;
    if (a.cmp === 'between' && !(a.value_max > a.value)) return `assertion ${n}: between needs value_max > value`;
    const s = a.scenario;
    if (s.kind === 'ticks' && a.at_tick > s.n) return `assertion ${n}: at_tick ${a.at_tick} is past the scenario's ${s.n} ticks`;
    if (s.kind === 'dragRelease') {
      const e = ids.get(s.entity);
      if (!e) return `assertion ${n}: dragRelease names unknown entity "${s.entity}"`;
      if (e.body_type !== 'dynamic') return `assertion ${n}: ${s.entity} is fixed and can't be dragged`;
      if (!s.drag_x_m && !s.drag_y_m) return `assertion ${n}: dragRelease needs a non-zero drag`;
    }
    if (s.kind === 'collision') {
      const e = ids.get(s.entity);
      if (!e || e.body_type !== 'dynamic') return `assertion ${n}: collision needs a dynamic entity, got "${s.entity}"`;
      if (s.other !== 'ground' && !exists(s.other)) return `assertion ${n}: collision names unknown entity "${s.other}"`;
      if (s.rel_speed_mps <= 0) return `assertion ${n}: collision needs rel_speed_mps > 0`;
    }
  }
  // Design: reject assertions that never mention an entity the router bound.
  const bound = [bindings.thisId, bindings.thatId, ...bindings.named].filter((x): x is string => !!x);
  if (bound.length) {
    const mentioned = plugin.assertions.some((a) =>
      bound.some((id) => a.target === `entity:${id}` || a.scenario.entity === id || a.scenario.other === id),
    );
    if (!mentioned) return `no assertion checks ${bound.join(' or ')}, the entity the command is about`;
  }
  const problems = checkPluginSource(plugin.source);
  if (problems.length) return `source: ${problems.join('; ')}`;
  return null;
}

function measure(sim: SimCore, a: Assertion): number {
  if (a.target === 'world') {
    if (a.field === 'gravity_x') return sim.gravity.x;
    if (a.field === 'gravity_y') return sim.gravity.y;
    return sim.currentTimeScale;
  }
  const v = sim.entityView(a.target.slice(7));
  if (!v) return NaN;
  if (a.field === 'alive') {
    const b = sim.bounds;
    const inside = v.x > -ALIVE_MARGIN_M && v.x < b.width + ALIVE_MARGIN_M && v.y > -b.height - ALIVE_MARGIN_M && v.y < b.height + ALIVE_MARGIN_M;
    return Number.isFinite(v.x + v.y) && inside ? 1 : 0;
  }
  if (a.field === 'spin') return Math.abs(v.angularVelocity);
  return v[a.field as 'speed' | 'vx' | 'vy' | 'x' | 'y' | 'restitution' | 'mass' | 'friction'];
}

function passes(a: Assertion, value: number, start: number): boolean {
  if (!Number.isFinite(value)) return false;
  switch (a.cmp) {
    case 'gt':
      return value > a.value;
    case 'lt':
      return value < a.value;
    case 'between':
      return value >= a.value && value <= a.value_max;
    case 'changed_by_gt':
      return Math.abs(value - start) > a.value;
  }
}

class ScenarioError extends Error {
  constructor(
    readonly stage: VerifyStage,
    message: string,
  ) {
    super(message);
  }
}

function unstable(sim: SimCore): string | null {
  for (const id of sim.ids) {
    const v = sim.entityView(id)!;
    if (![v.x, v.y, v.vx, v.vy, v.angle].every(Number.isFinite)) return `${id} has a non-finite position or velocity`;
    if (v.speed > MAX_SPEED_MPS) return `${id} moves at ${v.speed.toFixed(0)} m/s (limit ${MAX_SPEED_MPS})`;
  }
  return null;
}

/** Run one scenario; returns each assertion's value at every tick from 0 to its at_tick. */
function runScenario(
  req: VerifyRequest,
  scenario: Scenario,
  assertions: { a: Assertion; index: number }[],
  withPlugin: boolean,
  logs: string[],
  progress: () => void,
): Map<number, number[]> {
  const sim = SimCore.restore(req.snapshot, { seed: req.seed });
  const def: RuleDef = {
    kind: 'plugin',
    id: req.ruleId,
    name: req.plugin.name || 'plugin',
    summary: req.plugin.summary,
    writes: req.plugin.writes,
    source: req.plugin.source,
    bindings: req.bindings,
  };
  const pluginGone = () => {
    if (!withPlugin || sim.hasRule(req.ruleId)) return;
    const ev = sim.takeRuleEvents().find((e) => e.rule === req.ruleId && e.kind === 'failed');
    const detail = ev?.detail ?? 'the plugin was unloaded';
    throw new ScenarioError(/^(syntax error|unknown hook|hook `|the plugin must)/.test(detail) ? 'compile' : 'runtime', detail);
  };
  const step = () => {
    sim.step();
    pluginGone();
    const bad = unstable(sim);
    if (bad) throw new ScenarioError('stability', bad);
  };
  try {
    if (withPlugin) {
      sim.loadRule(def);
      pluginGone();
    }
    if (scenario.kind === 'dragRelease') {
      const start = sim.entityView(scenario.entity)!;
      sim.grabById(scenario.entity);
      for (let i = 1; i <= DRAG_STEPS + HOLD_STEPS; i++) {
        const f = Math.min(1, i / DRAG_STEPS);
        sim.drag((start.x + scenario.drag_x_m * f) * sim.ppm, (start.y + scenario.drag_y_m * f) * sim.ppm);
        step();
      }
      sim.release();
      pluginGone();
    } else if (scenario.kind === 'collision') {
      const a = sim.entityView(scenario.entity)!;
      if (scenario.other === 'ground') {
        sim.setPose(a.id, a.x, a.y - 0.05, 0, scenario.rel_speed_mps);
      } else {
        const b = sim.entityView(scenario.other)!;
        sim.setPose(a.id, b.x, b.y - (b.height / 2 + a.height / 2 + 0.05), 0, scenario.rel_speed_mps);
      }
    }
    const lastTick = Math.max(...assertions.map((x) => x.a.at_tick), scenario.kind === 'ticks' ? scenario.n : 0);
    const samples = new Map(assertions.map((x) => [x.index, [measure(sim, x.a)]]));
    for (let t = 1; t <= lastTick; t++) {
      step();
      for (const x of assertions) samples.get(x.index)!.push(measure(sim, x.a));
      if (t % PROGRESS_EVERY === 0) progress();
    }
    if (withPlugin) logs.push(...sim.takeLogs());
    return samples;
  } finally {
    sim.free();
  }
}

/** All scenario groups, each assertion evaluated at its own tick. */
function runAll(req: VerifyRequest, withPlugin: boolean, logs: string[], progress: () => void): { value: number; pass: boolean }[] {
  const groups = new Map<string, { scenario: Scenario; items: { a: Assertion; index: number }[] }>();
  req.plugin.assertions.forEach((a, index) => {
    const key = JSON.stringify(a.scenario);
    if (!groups.has(key)) groups.set(key, { scenario: a.scenario, items: [] });
    groups.get(key)!.items.push({ a, index });
  });
  const out: { value: number; pass: boolean }[] = [];
  for (const g of groups.values()) {
    const samples = runScenario(req, g.scenario, g.items, withPlugin, logs, progress);
    for (const { a, index } of g.items) {
      const s = samples.get(index)!;
      const value = s[a.at_tick];
      out[index] = { value, pass: passes(a, value, s[0]) };
    }
    progress();
  }
  return out;
}

export function verifyPlugin(req: VerifyRequest, progress: () => void = () => {}): VerifyResult {
  const t0 = performance.now();
  const logs: string[] = [];
  const done = (ok: boolean, stage: VerifyStage | null, message: string, results: AssertionResult[] = []): VerifyResult => ({
    ok,
    stage,
    message,
    results,
    ms: Math.round(performance.now() - t0),
    logs,
  });

  const problem = staticCheck(req.plugin, req.snapshot, req.bindings);
  if (problem) return done(false, 'static', problem);

  let withPlugin: { value: number; pass: boolean }[];
  try {
    withPlugin = runAll(req, true, logs, progress);
  } catch (e) {
    if (e instanceof ScenarioError) return done(false, e.stage, e.message);
    return done(false, 'runtime', (e as Error).message);
  }
  const results: AssertionResult[] = withPlugin.map((r, index) => ({ index, ...r, baselinePass: null, baselineValue: null }));
  const failed = results.find((r) => !r.pass);
  if (failed) return done(false, 'assertions', describeFailure(req.plugin.assertions[failed.index], failed.index, failed.value), results);

  const baseline = runAll(req, false, [], progress);
  baseline.forEach((b, i) => {
    results[i].baselinePass = b.pass;
    results[i].baselineValue = b.value;
  });
  if (baseline.every((b) => b.pass)) {
    return done(false, 'baseline', 'no-op: every assertion also passes without the plugin, so they don\'t test what it changes', results);
  }
  return done(true, null, `passed ${results.length} assertion${results.length === 1 ? '' : 's'}`, results);
}
