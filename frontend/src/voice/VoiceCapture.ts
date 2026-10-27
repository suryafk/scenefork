// Push-to-talk voice (eng review OV5): Chrome Web Speech is the primary path. Interim results
// go to the preset matcher as they arrive; the final transcript goes to the router.
interface SpeechResultLike {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}
interface SpeechEventLike {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechResultLike>;
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

export interface VoiceHandlers {
  /** Utterance text so far (finals + current interim); `startedAt` is when the key went down. */
  interim(text: string, startedAt: number): void;
  final(text: string, startedAt: number): void;
  listening(on: boolean): void;
  error(message: string): void;
}

function ctor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export class VoiceCapture {
  readonly supported = ctor() !== null;
  private rec: Recognition | null = null;
  private finals = '';
  private interimText = '';
  private startedAt = 0;
  private stopping = false;

  constructor(private readonly on: VoiceHandlers) {}

  get active(): boolean {
    return this.rec !== null;
  }

  start(): void {
    const Ctor = ctor();
    if (!Ctor) {
      this.on.error('Voice needs Chrome (Web Speech). Type the rule instead.');
      return;
    }
    if (this.rec) return;
    const rec = new Ctor();
    rec.lang = 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    this.finals = '';
    this.interimText = '';
    this.startedAt = performance.now();
    this.stopping = false;
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.finals += `${r[0].transcript} `;
        else interim += r[0].transcript;
      }
      this.interimText = interim;
      this.on.interim(`${this.finals}${interim}`.trim(), this.startedAt);
    };
    rec.onerror = (e) => {
      if (e.error !== 'aborted' && e.error !== 'no-speech') {
        this.on.error(e.error === 'not-allowed' ? 'Microphone permission was denied.' : `Voice error: ${e.error}`);
      }
    };
    rec.onend = () => {
      // Chrome ends continuous sessions on its own after silence; only a key-up finishes the utterance.
      if (this.rec !== rec) return;
      if (!this.stopping) {
        try {
          rec.start();
          return;
        } catch {
          // fall through and finish
        }
      }
      this.rec = null;
      this.on.listening(false);
      const text = `${this.finals}${this.interimText}`.trim();
      if (text) this.on.final(text, this.startedAt);
    };
    this.rec = rec;
    try {
      rec.start();
      this.on.listening(true);
    } catch (e) {
      this.rec = null;
      this.on.error(`Couldn't start the microphone: ${(e as Error).message}`);
    }
  }

  /** Key up: stop listening; the final transcript arrives through `final`. */
  stop(): void {
    if (!this.rec) return;
    this.stopping = true;
    this.rec.stop();
  }

  dispose(): void {
    const rec = this.rec;
    this.rec = null;
    rec?.abort();
  }
}
