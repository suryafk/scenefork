import { useState } from 'react';
import { PRESETS } from '../sim/rules';

const GRAVITY = PRESETS.filter((p) => p.group === 'gravity');
const G_LABEL: Record<string, string> = { zero_gravity: 'Zero-G', moon_gravity: 'Moon', mars_gravity: 'Mars', earth_gravity: 'Earth', jupiter_gravity: 'Jupiter' };

interface Props {
  supported: boolean;
  /** Muse Voice (via the backend) or Chrome's built-in speech recognition. */
  engine: 'meta' | 'web';
  listening: boolean;
  /** Live transcript while listening, or the last command heard. */
  transcript: string;
  building: boolean;
  onHoldStart: () => void;
  onHoldEnd: () => void;
  onSubmit: (text: string) => void;
  onPreset: (id: string) => void;
  /** The gravity preset in force, if any (highlights its button). */
  activeGravity: string | null;
}

const EXAMPLES = ['moon gravity', 'make this bouncy', 'slingshot the truck', 'reset'];

export function VoiceBar({ supported, engine, listening, transcript, building, onHoldStart, onHoldEnd, onSubmit, onPreset, activeGravity }: Props) {
  const [text, setText] = useState('');
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onSubmit(t);
    setText('');
  };
  return (
    <div className="voice">
      <button
        className={`mic ${listening ? 'mic-on' : ''}`}
        disabled={!supported}
        title={supported ? 'Hold to speak a rule (or hold Space)' : 'Voice needs Chrome (Web Speech)'}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          onHoldStart();
        }}
        onPointerUp={onHoldEnd}
        onPointerCancel={onHoldEnd}
      >
        {listening ? 'Listening…' : 'Hold to talk'} <kbd>Space</kbd>
      </button>
      <span className="engine" title={engine === 'meta' ? 'Transcribed by muse-voice-transcribe-1.0 through the backend' : "Chrome's speech recognition (the backend runs fake models)"}>
        {engine === 'meta' ? 'Muse Voice' : 'Chrome speech'}
      </span>
      <form
        className="rule-input"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`Type a rule, e.g. "${EXAMPLES[2]}"`}
          aria-label="Type a physics rule"
          maxLength={300}
        />
        <button type="submit" disabled={!text.trim()}>
          Apply
        </button>
      </form>
      <div className="gravity" role="group" aria-label="Gravity">
        <span>Gravity</span>
        {GRAVITY.map((p) => {
          const g = p.writes[0]?.value as [number, number] | undefined;
          return (
            <button key={p.id} aria-pressed={activeGravity === p.id} onClick={() => onPreset(p.id)} title={g ? `${g[1]} m/s²` : p.name}>
              {G_LABEL[p.id] ?? p.name}
            </button>
          );
        })}
      </div>
      <span className="transcript" aria-live="polite">
        {building ? 'Building rule… ' : ''}
        {transcript && <q>{transcript}</q>}
        {!transcript && !building && <span className="hint">Point at an object while you say “this”.</span>}
      </span>
    </div>
  );
}
