import { describe, expect, it } from 'vitest';
import { SNAP_WINDOW_S, StaticGoldenSource, type GoldenClip } from './GoldenController';

const clip: GoldenClip = {
  clip_id: 'desk_01',
  title: 'Desk',
  forks: [
    { fork_index: 0, t_fork: 1.5, manifest: 'desk_01/0/manifest.json' },
    { fork_index: 1, t_fork: 6, manifest: 'desk_01/1/manifest.json' },
  ],
};

describe('golden fork points', () => {
  it('snaps a pause near a prepared moment to it', () => {
    expect(StaticGoldenSource.forkFor(clip, 1.2)?.fork_index).toBe(0);
    expect(StaticGoldenSource.forkFor(clip, 6 + SNAP_WINDOW_S)?.fork_index).toBe(1);
  });

  it('forks live anywhere else instead of jumping to a far-away moment', () => {
    expect(StaticGoldenSource.forkFor(clip, 0.5)).toBeNull();
    expect(StaticGoldenSource.forkFor(clip, 3.8)).toBeNull();
    expect(StaticGoldenSource.forkFor(clip, 9)).toBeNull();
  });
});
