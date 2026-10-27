import { useState } from 'react';

interface Props {
  supported: boolean;
  listening: boolean;
  /** Live transcript while listening, or the last command heard. */
  transcript: string;
  building: boolean;
  onHoldStart: () => void;
  onHoldEnd: () => void;
  onSubmit: (text: string) => void;
}

const EXAMPLES = ['moon gravity', 'make this bouncy', 'slingshot the truck', 'reset'];

export function VoiceBar({ supported, listening, transcript, building, onHoldStart, onHoldEnd, onSubmit }: Props) {
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
      <span className="transcript" aria-live="polite">
        {building ? 'Building rule… ' : ''}
        {transcript && <q>{transcript}</q>}
        {!transcript && !building && <span className="hint">Point at an object while you say “this”.</span>}
      </span>
    </div>
  );
}
