import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { syntheticManifest } from '../scene/syntheticScene';
import { SimCore, initRapier } from './SimCore';
import { NO_BINDINGS, PRESETS, RuleStack, writeSetsConflict, type PluginDoc, type RuleDef } from './rules';
import { checkPluginSource } from './sandbox';
import { verifyPlugin } from './verifier';

beforeAll(async () => {
  await initRapier();
});

const shared = (name: string) => readFileSync(new URL(`../../../shared/${name}`, import.meta.url), 'utf8');
const [SLINGSHOT, SIDEWAYS] = JSON.parse(shared('fixtures/plugin_valid.json')) as PluginDoc[];

const preset = (presetId: string, targets: string[] | null = null): RuleDef => {
  const p = PRESETS.find((x) => x.id === presetId)!;
  return { kind: 'preset', id: `preset_${presetId}`, name: p.name, presetId, writes: p.writes, targets };
};
const plugin = (id: string, writes: string[], source: string): RuleDef => ({
  kind: 'plugin',
  id,
  name: id,
  summary: '',
  writes,
  source,
  bindings: NO_BINDINGS,
});
const run = (sim: SimCore, n: number) => {
  for (let i = 0; i < n; i++) sim.step();
};

describe('plugin source check (design: Plugin confinement, D6)', () => {
  it.each([
    ['Object.getPrototypeOf(ctx)', 'Object'],
    ['const a = Array.from([1])', 'Array'],
    ['return { onInit() { this.x = 1; } }', '`this`'],
    ['postMessage("hi")', 'postMessage'],
    ['fetch("https://x")', 'fetch'],
    ['const a = [1, 2]; let i = 0; a[i] = 3', 'computed member'],
    ['ctx.log["constr" + "uctor"]', 'computed member'],
    ['ctx.log.constructor("return self")()', 'constructor'],
    ['const o = { __proto__: null }', '__proto__'],
    ['if (ctx.entity("a") === undefined) {}', 'undefined'],
    ['function f() { return arguments[0]; }', 'arguments'],
    ['return { async onInit() {} }', 'async'],
    ['import("x")', 'import'],
    ['globalThis.x = 1', 'globalThis'],
    ['class A {}', 'classes'],
    ['return {', 'syntax error'],
  ])('rejects %s', (src, why) => {
    const problems = checkPluginSource(src);
    expect(problems.join(' | ')).toContain(why);
  });

  it('accepts ordinary plugin code', () => {
    expect(checkPluginSource(SLINGSHOT.source)).toEqual([]);
    const src = `
      const ids = ctx.entities().filter((id) => ctx.entity(id).dynamic);
      let t = 0;
      const pick = ([first, ...rest]) => first;
      return {
        onStep(dt) {
          t += dt;
          for (const id of ids) { const e = ctx.entity(id); if (e == null) continue; ctx.applyImpulse(id, 0, -Math.sin(t) * e.mass); }
          const first = pick(ids); ids[0];
        },
      };`;
    expect(checkPluginSource(src)).toEqual([]);
  });
});

describe('RuleStack', () => {
  it('restores each field correctly whatever order rules unload in', () => {
    const s = new RuleStack();
    s.setBase('world.gravity', [0, 9.81]);
    s.push('moon', 'world.gravity', [0, 1.62]);
    s.push('zero', 'world.gravity', [0, 0]);
    expect(s.effective('world.gravity')).toEqual([0, 0]);
    expect(s.pop('moon')).toEqual(['world.gravity']);
    expect(s.effective('world.gravity')).toEqual([0, 0]);
    s.pop('zero');
    expect(s.effective('world.gravity')).toEqual([0, 9.81]);
  });

  it('treats a wildcard entity write as overlapping every entity', () => {
    expect(writeSetsConflict(['entity:*.restitution'], ['entity:ball.restitution'])).toBe(true);
    expect(writeSetsConflict(['entity:truck.velocity'], ['entity:truck.velocity'])).toBe(true);
    expect(writeSetsConflict(['entity:truck.velocity'], ['entity:ball.velocity'])).toBe(false);
    expect(writeSetsConflict(['world.gravity'], ['world.time_scale'])).toBe(false);
  });
});

describe('rules in SimCore', () => {
  it('presets replace presets that write the same field and revert on unload', () => {
    const sim = new SimCore(syntheticManifest);
    sim.loadRule(preset('moon_gravity'));
    expect(sim.gravity.y).toBeCloseTo(1.62);
    sim.loadRule(preset('zero_gravity'));
    expect(sim.gravity.y).toBe(0);
    expect(sim.ruleInfos().map((r) => r.id)).toEqual(['preset_zero_gravity']);
    expect(sim.takeRuleEvents().map((e) => e.kind)).toEqual(['loaded', 'replaced', 'loaded']);
    sim.unloadRule('preset_zero_gravity');
    expect(sim.gravity.y).toBeCloseTo(9.81);
  });

  it('applies entity presets to the pointed-at entity only when targeted', () => {
    const sim = new SimCore(syntheticManifest);
    sim.loadRule(preset('bouncy', ['ball']));
    expect(sim.entityView('ball')!.restitution).toBe(0.95);
    expect(sim.entityView('crate')!.restitution).not.toBe(0.95);
    sim.resetRules();
    expect(sim.entityView('ball')!.restitution).not.toBe(0.95);
  });

  it('runs plugin hooks and reverts their stacked writes', () => {
    const sim = new SimCore(syntheticManifest);
    expect(sim.loadRule(plugin('heavy', ['entity:ball.mass'], 'return { onInit() { ctx.setMass("ball", 900); } };'))).toBe(true);
    expect(sim.entityView('ball')!.mass).toBe(900);
    sim.unloadRule('heavy');
    expect(sim.entityView('ball')!.mass).toBeLessThan(10);
  });

  it('unloads a plugin that writes a field it did not declare (OV8)', () => {
    const sim = new SimCore(syntheticManifest);
    expect(sim.loadRule(plugin('sneaky', ['entity:ball.mass'], 'return { onInit() { ctx.setGravity(0, -9); } };'))).toBe(false);
    expect(sim.gravity.y).toBeCloseTo(9.81);
    expect(sim.takeRuleEvents().at(-1)).toMatchObject({ kind: 'failed', detail: expect.stringContaining('without declaring') });
  });

  it('unloads a plugin whose hook throws, and one that produces NaN', () => {
    const sim = new SimCore(syntheticManifest);
    sim.loadRule(plugin('thrower', ['entity:ball.velocity'], 'let n = 0; return { onStep() { if (++n > 3) throw new Error("boom"); } };'));
    sim.loadRule(plugin('nan', ['entity:ball.velocity'], 'return { onStep() { ctx.applyImpulse("ball", NaN, 0); } };'));
    run(sim, 6);
    expect(sim.ruleInfos()).toEqual([]);
    const failed = sim.takeRuleEvents().filter((e) => e.kind === 'failed' || e.kind === 'replaced');
    expect(failed.map((e) => e.rule)).toEqual(['thrower', 'nan']); // same velocity field: nan replaced thrower
  });

  it('replaces a plugin steering the same entity and evicts the oldest past three', () => {
    const sim = new SimCore(syntheticManifest);
    const spin = (id: string, ent: string) => plugin(id, [`entity:${ent}.velocity`], `return { onStep() { ctx.setAngularVelocity("${ent}", 2); } };`);
    sim.loadRule(spin('a', 'ball'));
    sim.loadRule(spin('b', 'ball'));
    expect(sim.ruleInfos().map((r) => r.id)).toEqual(['b']);
    sim.loadRule(spin('c', 'crate'));
    sim.loadRule(spin('d', 'bin'));
    sim.loadRule(preset('moon_gravity')); // presets don't count toward the cap
    sim.loadRule(spin('e', 'truck'));
    expect(sim.ruleInfos().map((r) => r.id)).toEqual(['c', 'd', 'preset_moon_gravity', 'e']);
    expect(sim.takeRuleEvents().find((e) => e.kind === 'evicted')).toMatchObject({ rule: 'b', detail: 'e' });
  });

  it('a snapshot restores poses and presets but drops plugins', () => {
    const sim = new SimCore(syntheticManifest);
    sim.loadRule(preset('moon_gravity'));
    sim.loadRule(plugin('heavy', ['entity:ball.mass'], 'return { onInit() { ctx.setMass("ball", 900); } };'));
    sim.grab(sim.pose('ball').x, sim.pose('ball').y);
    sim.drag(200, 200);
    run(sim, 20);
    sim.release();
    const snap = JSON.parse(JSON.stringify(sim.snapshot())); // must survive structured clone
    const before = sim.pose('ball');
    const restored = SimCore.restore(snap);
    expect(restored.ids).toEqual(sim.ids);
    expect(restored.pose('ball').x).toBeCloseTo(before.x, 3);
    expect(restored.gravity.y).toBeCloseTo(1.62);
    expect(restored.ruleInfos().map((r) => r.id)).toEqual(['preset_moon_gravity']);
    expect(restored.entityView('ball')!.mass).toBeLessThan(10);
  });

  it('ctx exposes exactly the keys of shared/ctx.d.ts (contract test)', () => {
    const body = /export interface Ctx \{([\s\S]*?)\n\}/.exec(shared('ctx.d.ts'))![1];
    const declared = [...body.matchAll(/^\s+(?:readonly\s+)?(\w+)[(<:]/gm)].map((m) => m[1]).sort();
    const sim = new SimCore(syntheticManifest);
    const ctx = (sim as unknown as { makeCtx(rule: object): object }).makeCtx({ def: { bindings: NO_BINDINGS }, declared: [] });
    expect(Reflect.ownKeys(ctx).map(String).sort()).toEqual(declared);
  });
});

describe('verifier (design: Verifier, baseline diff)', () => {
  const req = (p: PluginDoc, bindings = NO_BINDINGS) => ({
    snapshot: new SimCore(syntheticManifest).snapshot(),
    plugin: p,
    bindings,
    ruleId: 'candidate',
    seed: 7,
  });

  it('passes the slingshot fixture and shows the baseline fails it', () => {
    const r = verifyPlugin(req(SLINGSHOT, { thisId: 'truck', thatId: null, named: [] }));
    expect(r.message).toBe('passed 1 assertion');
    expect(r.ok).toBe(true);
    expect(r.results[0].value).toBeGreaterThan(3);
    expect(r.results[0].baselinePass).toBe(false);
  });

  it('passes a world rule checked by a ticks scenario', () => {
    const r = verifyPlugin(req(SIDEWAYS));
    expect(r.ok, r.message).toBe(true);
  });

  it('rejects a no-op whose assertions pass without it', () => {
    const noop: PluginDoc = { ...SIDEWAYS, source: 'return { onInit() { ctx.setGravity(0, 9.81); } };', assertions: [{ ...SIDEWAYS.assertions[0], field: 'gravity_y', cmp: 'gt', value: 5 }] };
    const r = verifyPlugin(req(noop));
    expect(r).toMatchObject({ ok: false, stage: 'baseline' });
  });

  it('catches a NaN impulse as a runtime failure', () => {
    const nan: PluginDoc = { ...SLINGSHOT, source: 'return { onRelease(id) { ctx.applyImpulse(id, NaN, 0); } };' };
    const r = verifyPlugin(req(nan));
    expect(r).toMatchObject({ ok: false, stage: 'runtime' });
    expect(r.message).toContain('finite');
  });

  it('reports which assertion failed, with the measured value', () => {
    const weak: PluginDoc = { ...SLINGSHOT, assertions: [{ ...SLINGSHOT.assertions[0], value: 500 }] };
    const r = verifyPlugin(req(weak));
    expect(r.stage).toBe('assertions');
    expect(r.message).toMatch(/^assertion 1: entity:truck vx at tick 3 was \d/);
  });

  it('rejects assertions that ignore the bound entity, and undeclared writes', () => {
    expect(verifyPlugin(req(SIDEWAYS, { thisId: 'crate', thatId: null, named: [] })).message).toContain('crate');
    const undeclared: PluginDoc = { ...SIDEWAYS, writes: ['world.time_scale'] };
    expect(verifyPlugin(req(undeclared))).toMatchObject({ ok: false, stage: 'runtime' });
  });

  it('flags runaway speeds', () => {
    const rocket: PluginDoc = { ...SIDEWAYS, writes: ['entity:ball.velocity'], source: 'return { onStep() { ctx.applyImpulse("ball", 0, -500); } };' };
    expect(verifyPlugin(req(rocket))).toMatchObject({ ok: false, stage: 'stability' });
  });
});

describe('ctx units', () => {
  it('an impulse of mass * dv changes speed by dv even after mass compression', () => {
    const sim = new SimCore(syntheticManifest);
    // The truck's real mass and its compressed body mass differ (OV7: ratio at most 200:1).
    expect(sim.massOf('truck')).not.toBeCloseTo(sim.entityView('truck')!.mass, 0);
    sim.loadRule(plugin('kick', ['entity:truck.velocity'], 'return { onInit() { const e = ctx.entity("truck"); ctx.applyImpulse("truck", e.mass * 4, 0); } };'));
    expect(sim.entityView('truck')!.vx).toBeCloseTo(4, 3);
  });
});
