// Rule suggestions per scene: ask Muse Spark (through the backend) for a few things to say about
// the freed objects, and show them as chips. Asks again only when the set of named objects
// changes and has stayed put for a moment, so freeing three objects in a row makes one request.
import type { SceneSummary } from './RuleController';
import { matchPreset } from './router';

export interface Suggestion {
  text: string;
  kind: 'preset' | 'rule';
}

type Entity = SceneSummary['entities'][number];

/** Objects still waiting for grounding are called "object": nothing useful to suggest about them. */
const UNNAMED = /^object$/i;
export const SUGGEST_DELAY_MS = 1200;

export function sceneKey(entities: Entity[]): string {
  return entities
    .filter((e) => !UNNAMED.test(e.label))
    .map((e) => `${e.id}:${e.label}`)
    .sort()
    .join('|');
}

export class SuggestionTracker {
  private key = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: string | null = null;
  private seq = 0;

  constructor(
    private readonly send: (reqId: string, entities: Entity[]) => boolean,
    private readonly onChange: (suggestions: Suggestion[]) => void,
    private readonly delayMs = SUGGEST_DELAY_MS,
  ) {}

  /** Called with the current scene whenever it may have changed (cheap when it hasn't). */
  update(entities: Entity[]): void {
    const named = entities.filter((e) => !UNNAMED.test(e.label));
    const key = sceneKey(named);
    if (key === this.key) return;
    this.key = key;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!named.length) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const reqId = `sg${++this.seq}`;
      if (this.send(reqId, named)) this.pending = reqId;
      else this.key = ''; // offline: try again on the next update
    }, this.delayMs);
  }

  /**
   * A `suggestions` reply; stale ones (an older scene) are ignored. Each chip is labeled by what
   * will actually happen: the local preset router, not the model's guess, decides.
   */
  receive(reqId: string, suggestions: Suggestion[]): void {
    if (reqId !== this.pending) return;
    this.pending = null;
    this.onChange(suggestions.map((s) => ({ text: s.text, kind: matchPreset(s.text) ? 'preset' : 'rule' })));
  }

  /** A new scene: drop chips and anything in flight. */
  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.key = '';
    this.onChange([]);
  }
}
