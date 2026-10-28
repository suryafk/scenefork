import type { RuleInfo } from '../sim/rules';
import type { MutatorLogEntry } from '../voice/RuleController';

export interface HudStats {
  fps: number;
  stepMs: number;
  bodies: number;
  held: string | null;
  impacts: number;
  spend: { total: number; cap: number } | null;
  /** Click to freed (segment + compile) for the last object, as the backend measured it. */
  lastFreeMs: number | null;
  /** Verifier workers killed for going silent, and live workers restarted by the watchdog. */
  verifierKills: number;
  restarts: number;
}

interface Props {
  stats: HudStats;
  xray: boolean;
  muted: boolean;
  mode: 'demo' | 'fork' | 'golden';
  rules: RuleInfo[];
  log: MutatorLogEntry[];
  onToggleXray: () => void;
  onToggleMute: () => void;
  onReset: () => void;
  onRemoveRule: (id: string) => void;
  onResetRules: () => void;
}

const STAGE_LABEL: Record<MutatorLogEntry['stage'], string> = {
  preset: 'preset',
  reset: 'reset',
  writing: 'writing',
  testing: 'testing',
  repairing: 'repairing',
  installed: 'installed',
  failed: 'failed',
  fallback: 'fallback',
};

export function Hud({ stats, xray, muted, mode, rules, log, onToggleXray, onToggleMute, onReset, onRemoveRule, onResetRules }: Props) {
  return (
    <aside className={`hud ${xray ? 'hud-xray' : ''}`}>
      <div className="hud-row">
        <button onClick={onToggleXray} aria-pressed={xray}>
          X-Ray {xray ? 'on' : 'off'} <kbd>X</kbd>
        </button>
        <button onClick={onToggleMute} aria-pressed={!muted}>
          Sound {muted ? 'off' : 'on'} <kbd>M</kbd>
        </button>
        <button onClick={onReset}>{mode === 'demo' ? <>Reset <kbd>R</kbd></> : mode === 'golden' ? 'Leave clip' : 'Leave fork'}</button>
      </div>
      {rules.length > 0 && (
        <div className="hud-panel rules">
          <div className="hud-title">
            Active rules
            <button className="link" onClick={onResetRules}>
              reset all
            </button>
          </div>
          <ul>
            {rules.map((r) => (
              <li key={r.id} title={r.writes.join(', ')}>
                <span className={`badge badge-${r.kind}`}>{r.kind}</span>
                <span className="rule-name">{r.name}</span>
                <button className="x" aria-label={`Remove ${r.name}`} onClick={() => onRemoveRule(r.id)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {log.length > 0 && (
        <ol className="hud-panel mutator-log" aria-label="Mutator log">
          {log.map((e) => (
            <li key={e.id} className={`stage-${e.stage}`}>
              <span className="stage">{STAGE_LABEL[e.stage]}</span>
              <q>{e.text}</q>
              {e.attempt > 0 && e.stage !== 'failed' && <span className="attempt"> repair {e.attempt}</span>}
              <span className="ms"> {(e.ms / 1000).toFixed(1)}s</span>
              {e.detail && <div className="detail">{e.detail}</div>}
            </li>
          ))}
        </ol>
      )}
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
          {stats.lastFreeMs !== null && (
            <>
              <dt>Last free</dt>
              <dd>{stats.lastFreeMs} ms (segment + outline)</dd>
            </>
          )}
          <dt>Sandbox</dt>
          <dd>
            {stats.verifierKills} verifier kill{stats.verifierKills === 1 ? '' : 's'} · {stats.restarts} watchdog restart{stats.restarts === 1 ? '' : 's'}
          </dd>
          <dt>Model API spend</dt>
          <dd>{stats.spend ? `$${stats.spend.total.toFixed(3)} of $${stats.spend.cap.toFixed(2)} cap` : '$0.00 · offline'}</dd>
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
