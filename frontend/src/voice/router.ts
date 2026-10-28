// IntentRouter, local half (design: Intent routing, Resolving "this"/"that"). Presets match
// by regex in well under 5 ms with no model call; anything else goes to the MutatorAgent.
import { PRESETS, type Bindings, type Preset } from '../sim/rules';

export interface EntityRef {
  id: string;
  label: string;
}

export type Route =
  | { kind: 'empty' }
  | { kind: 'reset' }
  | { kind: 'preset'; preset: Preset; bindings: Bindings }
  | { kind: 'codegen'; bindings: Bindings; fallback: { preset: Preset; confidence: number } | null };

/** Commands with a condition or trigger are rules, not presets: "bouncy when it hits the cone". */
const CONDITIONAL = /\b(when|whenever|if|every|each time|after|until|unless|while|only)\b/;
const DEICTIC = /\b(this|that|these|those|it)\b/g;
const STOP = new Set(['the', 'a', 'an', 'and', 'object', 'thing', 'make', 'all', 'everything', 'stuff']);
export const FALLBACK_MIN_CONFIDENCE = 0.6;

const compiled = PRESETS.map((p) => ({ preset: p, res: p.patterns.map((x) => new RegExp(x, 'i')) }));

export function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9' -]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const words = (s: string) => normalize(s.replace(/_/g, ' ')).split(' ').filter(Boolean);
/** Crude plural strip: cones → cone, boxes → box, glass stays glass. */
const stem = (w: string) => (w.length > 3 && !w.endsWith('ss') ? w.replace(/(?<=[xz]|ch|sh)es$|s$/, '') : w);

/** A regex preset hit (confidence 1), unless the command is conditional. */
export function matchPreset(text: string): Preset | null {
  const t = normalize(text);
  if (!t || CONDITIONAL.test(t)) return null;
  return compiled.find((c) => c.res.some((re) => re.test(t)))?.preset ?? null;
}

/** Closest preset by keywords, for the codegen failure rule (design: Failure rule). */
export function closestPreset(text: string): { preset: Preset; confidence: number } | null {
  const ws = new Set(words(text).map(stem));
  let best: { preset: Preset; confidence: number } | null = null;
  for (const p of PRESETS) {
    if (p.action === 'reset') continue;
    const hits = p.keywords.filter((k) => ws.has(stem(k))).length;
    const confidence = hits >= 3 ? 1 : hits === 2 ? 0.8 : hits === 1 ? 0.6 : 0;
    if (confidence > (best?.confidence ?? 0)) best = { preset: p, confidence };
  }
  return best;
}

/**
 * "this"/"that" map to the entities the pointer dwelt on longest during the utterance (no word
 * timestamps from Web Speech); "the truck" maps by label, before any pointer data.
 */
export function resolveBindings(text: string, entities: EntityRef[], dwell: [string, number][]): Bindings {
  const said = words(text).filter((w) => w.length >= 3 && !STOP.has(w)).map(stem);
  // "phone" names a "smartphone", "cup" a "cup": words of 4+ letters may sit inside a label word.
  const matches = (labelWord: string) => said.some((w) => w === labelWord || (w.length >= 4 && labelWord.includes(w)));
  const named = entities
    .filter((e) => words(e.label).some((w) => w.length >= 3 && !STOP.has(w) && matches(stem(w))))
    .map((e) => e.id);
  const deictic = normalize(text).match(DEICTIC)?.length ?? 0;
  const ranked = [...dwell].sort((a, b) => b[1] - a[1]).map(([id]) => id).filter((id) => !named.includes(id));
  return {
    thisId: deictic >= 1 ? ranked[0] ?? null : null,
    thatId: deictic >= 2 ? ranked[1] ?? null : null,
    named,
  };
}

export function boundIds(b: Bindings): string[] {
  return [b.thisId, b.thatId, ...b.named].filter((x, i, all): x is string => !!x && all.indexOf(x) === i);
}

export function route(text: string, entities: EntityRef[], dwell: [string, number][]): Route {
  const t = normalize(text);
  if (!t) return { kind: 'empty' };
  const bindings = resolveBindings(t, entities, dwell);
  const preset = matchPreset(t);
  if (preset?.action === 'reset') return { kind: 'reset' };
  if (preset) return { kind: 'preset', preset, bindings };
  return { kind: 'codegen', bindings, fallback: closestPreset(t) };
}
