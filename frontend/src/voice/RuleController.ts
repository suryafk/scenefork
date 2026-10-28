// One spoken or typed command → a rule (design: Voice, Mutator contract, Verifier, Failure rule).
//
//   text ─► route ─┬─ reset ─────────────────────────────► unload every rule
//                  ├─ preset ────────────────────────────► RuleStack (worker), < 5 ms
//                  └─ codegen ─► MutatorAgent ─► verifier ─┬─ pass ─► install plugin
//                                   ▲                      └─ fail ─► repair (≤ 2), then
//                                   └──── error + plugin ──┘          closest preset or nothing
import type { SimSnapshot } from '../sim/SimCore';
import { NO_BINDINGS, type Bindings, type PluginDoc, type Preset, type RuleDef } from '../sim/rules';
import type { VerifyRequest, VerifyResult } from '../sim/verifier';
import { FALLBACK_MIN_CONFIDENCE, boundIds, matchPreset, route, type EntityRef } from './router';

export const MAX_REPAIRS = 2;

export interface SceneSummary {
  bounds_m: { width: number; height: number };
  gravity: [number, number];
  entities: { id: string; label: string; dynamic: boolean; x: number; y: number; width: number; height: number; mass_kg: number }[];
}

export interface CodegenRequest {
  text: string;
  scene: SceneSummary;
  bindings: Bindings;
  attempt: number;
  previous: { plugin: PluginDoc; error: string } | null;
}

export type CodegenReply =
  | { ok: true; plugin: PluginDoc; problems: string[]; ms: number }
  | { ok: false; reason: string; message: string };

export type LogStage = 'preset' | 'reset' | 'writing' | 'testing' | 'repairing' | 'installed' | 'failed' | 'fallback';

export interface MutatorLogEntry {
  id: string;
  text: string;
  stage: LogStage;
  detail: string;
  attempt: number;
  /** Milliseconds since the command was heard. */
  ms: number;
}

export interface RulePorts {
  physics: { loadRule(def: RuleDef): void; resetRules(): void; latestSnapshot: SimSnapshot | null };
  verify(req: VerifyRequest): Promise<VerifyResult>;
  codegen(req: CodegenRequest): Promise<CodegenReply>;
  log(entry: MutatorLogEntry): void;
  toast(text: string): void;
}

const r2 = (v: number) => Math.round(v * 10) / 10;

/** What the MutatorAgent sees of the world: small, rounded (so the dev cache hits on repeats). */
export function summarize(snap: SimSnapshot): SceneSummary {
  const ppm = snap.manifest.pixels_per_meter;
  const pose = new Map(snap.bodies.map((b) => [b.id, b]));
  return {
    bounds_m: { width: r2(snap.manifest.resolution.width / ppm), height: r2(snap.manifest.resolution.height / ppm) },
    gravity: [0, snap.manifest.gravity_mps2],
    entities: snap.manifest.entities.map((e) => {
      const xs = e.polygon_px.map((p) => p[0]);
      const ys = e.polygon_px.map((p) => p[1]);
      const b = pose.get(e.id);
      return {
        id: e.id,
        label: e.label,
        dynamic: e.body_type === 'dynamic',
        x: r2(b?.x ?? 0),
        y: r2(b?.y ?? 0),
        width: r2((Math.max(...xs) - Math.min(...xs)) / ppm),
        height: r2((Math.max(...ys) - Math.min(...ys)) / ppm),
        mass_kg: Math.round(e.physics.mass_kg * 100) / 100,
      };
    }),
  };
}

function seedFor(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export class RuleController {
  private n = 0;
  private busy = false;
  /** Interim preset hits per utterance, so the final transcript doesn't apply them twice. */
  private readonly interimApplied = new Map<number, string>();
  /** Bumped on every scene load: a rule still being built for the old scene is dropped. */
  private scene = 0;

  constructor(private readonly ports: RulePorts) {}

  /** A new scene loaded (demo, live fork or golden clip): its rules start empty. */
  newScene(): void {
    this.scene++;
    this.interimApplied.clear();
  }

  get building(): boolean {
    return this.busy;
  }

  private entities(): EntityRef[] {
    return this.ports.physics.latestSnapshot?.manifest.entities.map((e) => ({ id: e.id, label: e.label })) ?? [];
  }

  private presetDef(preset: Preset, bindings: Bindings): RuleDef {
    const touchesEntities = preset.writes.some((w) => w.field.startsWith('entity:'));
    const bound = boundIds(bindings);
    return {
      kind: 'preset',
      id: `preset_${preset.id}`,
      name: preset.name,
      presetId: preset.id,
      writes: preset.writes,
      targets: touchesEntities && bound.length ? bound : null,
    };
  }

  private applyPreset(preset: Preset, bindings: Bindings, text: string, t0: number, stage: LogStage = 'preset'): void {
    const def = this.presetDef(preset, bindings);
    this.ports.physics.loadRule(def);
    const on = def.kind === 'preset' && def.targets ? ` on ${def.targets.join(', ')}` : '';
    this.ports.log({ id: `cmd_${++this.n}`, text, stage, detail: `${preset.name}${on}`, attempt: 0, ms: Math.round(performance.now() - t0) });
  }

  /** Interim transcript: apply a preset the moment it's recognizable (target < 300 ms). */
  interim(text: string, utterance: number, dwell: [string, number][]): void {
    if (this.interimApplied.has(utterance)) return;
    const preset = matchPreset(text);
    if (!preset || preset.action === 'reset') return;
    this.interimApplied.set(utterance, preset.id);
    const r = route(text, this.entities(), dwell);
    this.applyPreset(preset, r.kind === 'preset' ? r.bindings : NO_BINDINGS, text, performance.now());
  }

  /** A final transcript or a typed command. */
  async command(text: string, dwell: [string, number][], utterance?: number): Promise<void> {
    const t0 = performance.now();
    const r = route(text, this.entities(), dwell);
    const already = utterance !== undefined ? this.interimApplied.get(utterance) : undefined;
    if (utterance !== undefined) this.interimApplied.delete(utterance);
    if (r.kind === 'empty') return;
    if (r.kind === 'reset') {
      this.ports.physics.resetRules();
      this.ports.log({ id: `cmd_${++this.n}`, text, stage: 'reset', detail: 'every rule removed', attempt: 0, ms: 0 });
      return;
    }
    if (r.kind === 'preset') {
      if (already !== r.preset.id) this.applyPreset(r.preset, r.bindings, text, t0);
      return;
    }
    if (already) return; // the interim preset was what they meant; don't also write code
    if (this.busy) {
      this.ports.toast('Still building the last rule. One at a time.');
      return;
    }
    this.busy = true;
    try {
      await this.codegen(text, r.bindings, r.fallback, t0);
    } finally {
      this.busy = false;
    }
  }

  private async codegen(text: string, bindings: Bindings, fallback: { preset: Preset; confidence: number } | null, t0: number): Promise<void> {
    const sceneAtStart = this.scene;
    const id = `cmd_${++this.n}`;
    const log = (stage: LogStage, detail: string, attempt: number) =>
      this.ports.log({ id, text, stage, detail, attempt, ms: Math.round(performance.now() - t0) });
    const snap = this.ports.physics.latestSnapshot;
    if (!snap) {
      this.ports.toast('The scene is still loading.');
      return;
    }
    const scene = summarize(snap);
    let previous: CodegenRequest['previous'] = null;
    let error = '';
    for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
      log(attempt === 0 ? 'writing' : 'repairing', attempt === 0 ? 'asking Muse Spark for a plugin' : `fixing: ${error}`, attempt);
      const reply = await this.ports.codegen({ text, scene, bindings, attempt, previous });
      if (this.scene !== sceneAtStart) return; // the scene changed while the model was writing
      if (!reply.ok) {
        error = reply.message;
        break;
      }
      const plugin = reply.plugin;
      if (!plugin.feasible) {
        error = `not possible with this API: ${plugin.reason || 'no reason given'}`;
        break;
      }
      if (reply.problems.length) {
        error = `the plugin didn't match the schema: ${reply.problems.join('; ')}`;
      } else {
        log('testing', `verifying ${plugin.assertions.length} assertion${plugin.assertions.length === 1 ? '' : 's'}`, attempt);
        const result = await this.ports.verify({
          snapshot: this.ports.physics.latestSnapshot ?? snap,
          plugin,
          bindings,
          ruleId: `${id}_${plugin.name || 'plugin'}`,
          seed: seedFor(text),
        });
        if (this.scene !== sceneAtStart) return;
        if (result.ok) {
          this.ports.physics.loadRule({
            kind: 'plugin',
            id: `${id}_${plugin.name || 'plugin'}`,
            name: plugin.name || 'plugin',
            summary: plugin.summary,
            writes: plugin.writes,
            source: plugin.source,
            bindings,
          });
          log('installed', `${plugin.summary || plugin.name} (${result.message}, ${result.ms} ms in the verifier)`, attempt);
          return;
        }
        error = result.message;
      }
      previous = { plugin, error };
    }
    // Design: Failure rule. The HUD always shows why.
    if (fallback && fallback.confidence >= FALLBACK_MIN_CONFIDENCE) {
      this.applyPreset(fallback.preset, bindings, text, t0, 'fallback');
      log('failed', error, MAX_REPAIRS);
      this.ports.toast(`Couldn't build that rule, applied ${fallback.preset.name} instead.`);
    } else {
      log('failed', error, MAX_REPAIRS);
      this.ports.toast("Couldn't build that rule.");
    }
  }
}
