// Push-to-talk through Muse Voice Transcribe (the Meta path, eng review OV5). The mic is captured
// at 16 kHz, cut into 80 ms frames of signed 16-bit PCM and streamed over the session WebSocket;
// the backend proxies it to the realtime API (the key never reaches the browser). Partials and
// the final transcript come back as voice_partial / voice_final.
import { trace } from '../debug';
import type { VoiceHandlers } from './VoiceCapture';

const RATE = 16_000;
const FRAME_SAMPLES = (RATE * 80) / 1000;

/** Copies each 128-sample render quantum to the main thread. Inline, so no extra bundle entry. */
const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('sf-tap', Tap);
`;

export interface VoiceLink {
  start(reqId: string, keywords: string[]): boolean;
  audio(pcm: ArrayBuffer): void;
  end(reqId: string): void;
}

interface Capture {
  stream: MediaStream;
  ctx: AudioContext;
  node: AudioWorkletNode;
}

export class MetaVoiceCapture {
  readonly supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof AudioWorkletNode !== 'undefined';
  private capture: Capture | null = null;
  private reqId: string | null = null;
  /** The utterance whose key is still held; cleared on release (reqId lives on until the final). */
  private recording: string | null = null;
  private startedAt = 0;
  private seq = 0;
  private pending = new Int16Array(FRAME_SAMPLES);
  private filled = 0;
  /** 80 ms frames sent this utterance (dev trace). */
  private frames = 0;

  constructor(
    private readonly link: VoiceLink,
    private readonly on: VoiceHandlers,
    private readonly keywords: () => string[],
  ) {}

  get active(): boolean {
    return this.reqId !== null;
  }

  start(): void {
    if (this.recording) return;
    const reqId = `voice${++this.seq}`;
    if (!this.link.start(reqId, this.keywords())) {
      this.on.error("Can't reach the SceneFork backend for voice.");
      return;
    }
    this.reqId = reqId;
    this.recording = reqId;
    this.startedAt = performance.now();
    this.filled = 0;
    this.on.listening(true);
    void this.openMic(reqId);
  }

  private async openMic(reqId: string): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      const ctx = new AudioContext({ sampleRate: RATE });
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(ctx, 'sf-tap');
      node.port.onmessage = (e: MessageEvent<Float32Array>) => this.push(e.data);
      ctx.createMediaStreamSource(stream).connect(node);
      const capture = { stream, ctx, node };
      if (this.recording !== reqId) {
        // Released before the mic came up: turn it straight off again.
        this.release(capture);
        return;
      }
      this.capture = capture;
    } catch (e) {
      const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      this.on.error(denied ? 'Microphone permission was denied.' : `Couldn't start the microphone: ${(e as Error).message}`);
      if (this.reqId === reqId) this.stop();
    }
  }

  /** Float samples → 80 ms frames of s16le, sent as they fill. */
  private push(samples: Float32Array): void {
    if (!this.recording) return;
    for (const s of samples) {
      this.pending[this.filled++] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
      if (this.filled === FRAME_SAMPLES) {
        this.link.audio(this.pending.slice().buffer);
        this.frames++;
        this.filled = 0;
      }
    }
  }

  /** Key up: send what's left and end the turn; the final transcript arrives through `final`. */
  stop(): void {
    const reqId = this.recording;
    if (!reqId) return;
    this.recording = null;
    if (this.filled) this.link.audio(this.pending.slice(0, this.filled).buffer);
    this.filled = 0;
    this.link.end(reqId);
    trace('[voice] sent', this.frames, 'frames', this.capture ? 'mic open' : 'mic not open');
    this.frames = 0;
    if (this.capture) this.release(this.capture);
    this.capture = null;
    this.on.listening(false);
    // reqId stays until the final arrives, so its result maps back to this utterance.
  }

  private release(c: Capture): void {
    c.node.port.onmessage = null;
    c.stream.getTracks().forEach((t) => t.stop());
    void c.ctx.close();
  }

  /** Backend messages for this capture. */
  partial(reqId: string, text: string): void {
    if (reqId === this.reqId && text) this.on.interim(text, this.startedAt);
  }

  final(reqId: string, text: string): void {
    if (reqId !== this.reqId) return;
    this.reqId = null;
    if (text.trim()) this.on.final(text.trim(), this.startedAt);
  }

  failed(reqId: string, message: string): void {
    if (reqId !== this.reqId) return;
    if (this.capture) this.release(this.capture);
    this.capture = null;
    this.reqId = null;
    this.recording = null;
    this.on.listening(false);
    this.on.error(`Muse Voice failed: ${message}`);
  }

  dispose(): void {
    if (this.capture) this.release(this.capture);
    this.capture = null;
    this.reqId = null;
    this.recording = null;
  }
}
