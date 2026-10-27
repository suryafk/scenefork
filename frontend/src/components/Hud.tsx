export interface HudStats {
  fps: number;
  stepMs: number;
  bodies: number;
  held: string | null;
  impacts: number;
}

interface Props {
  stats: HudStats;
  xray: boolean;
  muted: boolean;
  onToggleXray: () => void;
  onToggleMute: () => void;
  onReset: () => void;
}

export function Hud({ stats, xray, muted, onToggleXray, onToggleMute, onReset }: Props) {
  return (
    <aside className={`hud ${xray ? 'hud-xray' : ''}`}>
      <div className="hud-row">
        <button onClick={onToggleXray} aria-pressed={xray}>
          X-Ray {xray ? 'on' : 'off'} <kbd>X</kbd>
        </button>
        <button onClick={onToggleMute} aria-pressed={!muted}>
          Sound {muted ? 'off' : 'on'} <kbd>M</kbd>
        </button>
        <button onClick={onReset}>
          Reset <kbd>R</kbd>
        </button>
      </div>
      {xray && (
        <dl className="hud-stats">
          <dt>Render</dt>
          <dd>{stats.fps} fps</dd>
          <dt>Physics step</dt>
          <dd>{stats.stepMs.toFixed(2)} ms (worker)</dd>
          <dt>Bodies</dt>
          <dd>{stats.bodies}</dd>
          <dt>Holding</dt>
          <dd>{stats.held ?? 'nothing'}</dd>
          <dt>Impacts</dt>
          <dd>{stats.impacts}</dd>
          <dt>Model API spend</dt>
          <dd>$0.00 · offline scene</dd>
        </dl>
      )}
      {xray && (
        <ul className="legend">
          <li><i style={{ background: '#00ffd0' }} /> collision hull</li>
          <li><i style={{ background: '#ffd54f' }} /> fixed hull</li>
          <li><i style={{ background: '#ff3b81' }} /> center of mass</li>
          <li><i style={{ background: '#7cff4d' }} /> velocity</li>
          <li><i style={{ background: '#4dd0ff' }} /> own floor (dim: released)</li>
        </ul>
      )}
    </aside>
  );
}
