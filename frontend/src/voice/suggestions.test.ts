import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUGGEST_DELAY_MS, SuggestionTracker, type Suggestion } from './Suggestions';

const e = (id: string, label: string) => ({ id, label, dynamic: true, x: 0, y: 0, width: 1, height: 1, mass_kg: 1 });

function harness(online = true) {
  const sent: { reqId: string; labels: string[] }[] = [];
  let shown: Suggestion[] = [];
  const t = new SuggestionTracker(
    (reqId, entities) => {
      if (online) sent.push({ reqId, labels: entities.map((x) => x.label) });
      return online;
    },
    (s) => (shown = s),
  );
  return { t, sent, shown: () => shown };
}

describe('SuggestionTracker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('asks once the freed objects stop changing, and only for named ones', () => {
    const h = harness();
    h.t.update([e('obj_1', 'object')]); // still waiting for grounding
    vi.advanceTimersByTime(SUGGEST_DELAY_MS * 2);
    expect(h.sent).toEqual([]);
    h.t.update([e('obj_1', 'cactus')]);
    vi.advanceTimersByTime(SUGGEST_DELAY_MS / 2);
    h.t.update([e('obj_1', 'cactus'), e('obj_2', 'mug')]); // freeing another restarts the wait
    vi.advanceTimersByTime(SUGGEST_DELAY_MS / 2);
    expect(h.sent).toEqual([]);
    vi.advanceTimersByTime(SUGGEST_DELAY_MS);
    expect(h.sent).toEqual([{ reqId: 'sg1', labels: ['cactus', 'mug'] }]);
    h.t.update([e('obj_2', 'mug'), e('obj_1', 'cactus')]); // same set, other order: no new request
    vi.advanceTimersByTime(SUGGEST_DELAY_MS * 2);
    expect(h.sent).toHaveLength(1);
  });

  it('shows the latest reply and ignores stale ones', () => {
    const h = harness();
    h.t.update([e('obj_1', 'cactus')]);
    vi.advanceTimersByTime(SUGGEST_DELAY_MS);
    h.t.update([e('obj_1', 'cactus'), e('obj_2', 'mug')]);
    vi.advanceTimersByTime(SUGGEST_DELAY_MS);
    h.t.receive('sg1', [{ text: 'old', kind: 'rule' }]);
    expect(h.shown()).toEqual([]);
    h.t.receive('sg2', [{ text: 'zero gravity', kind: 'rule' }, { text: 'make the cactus bounce like rubber', kind: 'rule' }, { text: 'launch the mug when it hits the stapler', kind: 'preset' }]);
    // Labeled by what the router will do, not the model's guess.
    expect(h.shown().map((s) => s.kind)).toEqual(['preset', 'preset', 'rule']);
  });

  it('clears chips on a new scene and retries after being offline', () => {
    const off = harness(false);
    off.t.update([e('obj_1', 'cactus')]);
    vi.advanceTimersByTime(SUGGEST_DELAY_MS);
    off.t.update([e('obj_1', 'cactus')]); // the key was forgotten, so it schedules again
    vi.advanceTimersByTime(SUGGEST_DELAY_MS);
    const h = harness();
    h.t.update([e('obj_1', 'cactus')]);
    vi.advanceTimersByTime(SUGGEST_DELAY_MS);
    h.t.reset();
    h.t.receive('sg1', [{ text: 'late', kind: 'rule' }]);
    expect(h.shown()).toEqual([]);
  });
});
