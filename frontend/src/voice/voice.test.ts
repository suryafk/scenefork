import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { syntheticManifest } from '../scene/syntheticScene';
import { SimCore, initRapier } from '../sim/SimCore';
import type { PluginDoc, RuleDef } from '../sim/rules';
import { verifyPlugin } from '../sim/verifier';
import { RuleController, type CodegenReply, type CodegenRequest, type MutatorLogEntry } from './RuleController';
import { closestPreset, matchPreset, resolveBindings, route } from './router';

beforeAll(async () => {
  await initRapier();
});

const [SLINGSHOT] = JSON.parse(readFileSync(new URL('../../../shared/fixtures/plugin_valid.json', import.meta.url), 'utf8')) as PluginDoc[];
const ENTITIES = syntheticManifest.entities.map((e) => ({ id: e.id, label: e.label }));

describe('router', () => {
  it.each([
    ['make gravity like the moon', 'moon_gravity'],
    ['Zero gravity!', 'zero_gravity'],
    ['everything bouncy', 'bouncy'],
    ['slow motion please', 'slow_motion'],
    ['flip the gravity', 'reverse_gravity'],
    ['make the floor icy', 'slippery'],
    ['reset', 'reset'],
  ])('"%s" is the %s preset', (text, id) => {
    expect(matchPreset(text)?.id).toBe(id);
  });

  it('sends conditional and unknown commands to codegen', () => {
    expect(matchPreset('make it bouncy when it hits the cone')).toBeNull();
    expect(route('slingshot this truck', ENTITIES, []).kind).toBe('codegen');
  });

  it('matches named entities by label and "this" by longest dwell', () => {
    const b = resolveBindings('slingshot this at the truck', ENTITIES, [['ball', 400], ['crate', 900]]);
    expect(b).toEqual({ thisId: 'crate', thatId: null, named: ['truck'] });
    expect(resolveBindings('put this on that', ENTITIES, [['ball', 400], ['crate', 900]])).toMatchObject({ thisId: 'crate', thatId: 'ball' });
    expect(resolveBindings('spin the cones', ENTITIES, []).named).toEqual(['cone_1', 'cone_2']);
  });

  it('matches a shorter spoken name inside a longer label', () => {
    const desk = [{ id: 'obj_7', label: 'smartphone' }, { id: 'obj_6', label: 'blue ceramic mug' }, { id: 'obj_1', label: 'small potted cactus' }];
    expect(resolveBindings('slingshot the phone', desk, []).named).toEqual(['obj_7']);
    expect(resolveBindings('spin the mug', desk, []).named).toEqual(['obj_6']);
    expect(resolveBindings('make the pot heavy', desk, []).named).toEqual([]); // 3 letters: whole words only
  });

  it('finds the closest preset for the failure rule', () => {
    expect(closestPreset('make everything float around in space')).toMatchObject({ preset: { id: 'zero_gravity' }, confidence: 0.8 });
    expect(closestPreset('paint the truck blue')).toBeNull();
  });
});

function harness(replies: (req: CodegenRequest) => CodegenReply) {
  const sim = new SimCore(syntheticManifest);
  const loaded: RuleDef[] = [];
  const logs: MutatorLogEntry[] = [];
  const toasts: string[] = [];
  const requests: CodegenRequest[] = [];
  const controller = new RuleController({
    physics: { loadRule: (d) => loaded.push(d), resetRules: () => loaded.push({ kind: 'preset', id: 'RESET', name: '', presetId: '', writes: [], targets: null }), latestSnapshot: sim.snapshot() },
    verify: async (req) => verifyPlugin(req),
    codegen: async (req) => {
      requests.push(structuredClone(req));
      return replies(req);
    },
    log: (e) => logs.push(e),
    toast: (t) => toasts.push(t),
  });
  return { controller, loaded, logs, toasts, requests };
}

describe('RuleController', () => {
  it('applies a targeted preset with no model call', async () => {
    const h = harness(() => {
      throw new Error('no codegen expected');
    });
    await h.controller.command('make this bouncy', [['ball', 800]]);
    expect(h.loaded).toEqual([expect.objectContaining({ kind: 'preset', presetId: 'bouncy', targets: ['ball'] })]);
  });

  it('does not apply a preset twice when the interim result already did', async () => {
    const h = harness(() => ({ ok: false, reason: 'error', message: 'unexpected' }));
    h.controller.interim('moon gra', 1, []);
    await h.controller.command('moon gravity', [], 1);
    expect(h.loaded).toHaveLength(1);
  });

  it('installs a plugin that passes verification on the first try', async () => {
    const h = harness(() => ({ ok: true, plugin: SLINGSHOT, problems: [], ms: 10 }));
    await h.controller.command('slingshot the truck', []);
    expect(h.requests[0].bindings.named).toEqual(['truck']);
    expect(h.requests[0].scene.entities.find((e) => e.id === 'truck')).toMatchObject({ dynamic: true });
    expect(h.loaded).toEqual([expect.objectContaining({ kind: 'plugin', name: 'slingshot_truck', writes: ['entity:truck.velocity'] })]);
    expect(h.logs.map((l) => l.stage)).toEqual(['writing', 'testing', 'installed']);
  });

  it('sends the failed assertion back for repair, then installs the fix', async () => {
    const broken: PluginDoc = { ...SLINGSHOT, source: SLINGSHOT.source.replace('12 * e.mass', '0.01 * e.mass') };
    const h = harness((req) => ({ ok: true, plugin: req.attempt === 0 ? broken : SLINGSHOT, problems: [], ms: 10 }));
    await h.controller.command('slingshot the truck', []);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].previous?.error).toMatch(/^assertion 1: entity:truck vx at tick 3 was/);
    expect(h.requests[1].previous?.plugin.source).toBe(broken.source);
    expect(h.logs.map((l) => l.stage)).toEqual(['writing', 'testing', 'repairing', 'testing', 'installed']);
  });

  it('drops a rule still being built when the scene changes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness(() => ({ ok: true, plugin: SLINGSHOT, problems: [], ms: 10 }));
    const slow = new RuleController({
      ...(h.controller as unknown as { ports: ConstructorParameters<typeof RuleController>[0] }).ports,
      codegen: async () => {
        await gate;
        return { ok: true, plugin: SLINGSHOT, problems: [], ms: 10 };
      },
    });
    const pending = slow.command('slingshot the truck', []);
    slow.newScene(); // the user switched clips while Muse Spark was writing
    release();
    await pending;
    expect(h.loaded).toEqual([]);
  });

  it('gives up after two repairs and falls back to the closest preset', async () => {
    const noop: PluginDoc = { ...SLINGSHOT, source: 'return {};' };
    const h = harness(() => ({ ok: true, plugin: noop, problems: [], ms: 10 }));
    await h.controller.command('make everything float in space with sparkles', []);
    expect(h.requests).toHaveLength(3);
    expect(h.loaded).toEqual([expect.objectContaining({ presetId: 'zero_gravity' })]);
    expect(h.toasts).toEqual(["Couldn't build that rule, applied Zero gravity instead."]);
    expect(h.logs.at(-1)).toMatchObject({ stage: 'failed' });
  });

  it('fails gracefully on an impossible request without repairs', async () => {
    const h = harness(() => ({ ok: true, plugin: { ...SLINGSHOT, feasible: false, reason: 'no colors in the API' }, problems: [], ms: 5 }));
    await h.controller.command('paint the truck blue', []);
    expect(h.requests).toHaveLength(1);
    expect(h.loaded).toEqual([]);
    expect(h.toasts).toEqual(["Couldn't build that rule."]);
    expect(h.logs.at(-1)?.detail).toContain('no colors');
  });
});
