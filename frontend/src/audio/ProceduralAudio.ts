// Zero-asset impact sounds: each material is a short noise burst through a band-pass
// filter plus a few decaying partials. Loudness follows impact speed, pitch drops with mass.
import type { AcousticMaterial, CollisionEvent } from '../sim/types';

interface Profile {
  /** Partial frequency ratios over the base frequency. */
  partials: number[];
  base: number;
  decay: number;
  wave: OscillatorType;
  noiseHz: number;
  noiseQ: number;
  noiseDecay: number;
}

const PROFILES: Record<AcousticMaterial, Profile> = {
  hollow_metal: { partials: [1, 2.76, 5.4], base: 170, decay: 0.7, wave: 'triangle', noiseHz: 2500, noiseQ: 3, noiseDecay: 0.08 },
  solid_metal: { partials: [1, 2.4, 3.9], base: 420, decay: 1.1, wave: 'sine', noiseHz: 4000, noiseQ: 8, noiseDecay: 0.03 },
  glass: { partials: [1, 2.32, 4.25], base: 1300, decay: 0.5, wave: 'sine', noiseHz: 6000, noiseQ: 10, noiseDecay: 0.04 },
  ceramic: { partials: [1, 2.1, 3.7], base: 900, decay: 0.25, wave: 'sine', noiseHz: 3500, noiseQ: 5, noiseDecay: 0.03 },
  wood: { partials: [1, 1.7, 2.6], base: 220, decay: 0.12, wave: 'triangle', noiseHz: 1200, noiseQ: 2, noiseDecay: 0.05 },
  rubber: { partials: [1], base: 110, decay: 0.09, wave: 'sine', noiseHz: 400, noiseQ: 1, noiseDecay: 0.03 },
  plastic: { partials: [1, 1.9], base: 380, decay: 0.08, wave: 'triangle', noiseHz: 1800, noiseQ: 1.5, noiseDecay: 0.04 },
  flesh_cloth: { partials: [1], base: 90, decay: 0.06, wave: 'sine', noiseHz: 300, noiseQ: 0.7, noiseDecay: 0.05 },
  concrete: { partials: [1, 1.6], base: 90, decay: 0.08, wave: 'sine', noiseHz: 900, noiseQ: 0.8, noiseDecay: 0.07 },
  water: { partials: [], base: 0, decay: 0, wave: 'sine', noiseHz: 800, noiseQ: 0.5, noiseDecay: 0.2 },
};

const MAX_VOICES = 16;

export class ProceduralAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private voices = 0;
  muted = false;

  /** Browsers only start audio after a user gesture: call this from pointerdown. */
  unlock(): void {
    if (!this.ctx) {
      const ctx = new AudioContext();
      const comp = ctx.createDynamicsCompressor();
      const master = ctx.createGain();
      master.gain.value = 0.8;
      master.connect(comp).connect(ctx.destination);
      const noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      this.ctx = ctx;
      this.master = master;
      this.noise = noise;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  impact(e: CollisionEvent): void {
    if (this.muted || !this.ctx) return;
    const loud = Math.pow(Math.min(1, e.speed_mps / 10), 1.2);
    // Pitch falls gently with mass: heavy things thud, light things tick.
    const pitch = Math.min(2, Math.max(0.5, Math.pow(5 / Math.max(e.mass_a, 0.1), 0.15)));
    this.voice(PROFILES[e.material_a], loud * 0.55, pitch);
    if (e.material_b !== e.material_a) this.voice(PROFILES[e.material_b], loud * 0.3, 1);
  }

  private voice(p: Profile, gain: number, pitch: number): void {
    const ctx = this.ctx!;
    if (gain < 0.01 || this.voices >= MAX_VOICES) return;
    this.voices++;
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = gain;
    out.connect(this.master!);
    const end = now + Math.max(p.decay, p.noiseDecay) + 0.05;

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = p.noiseHz * (0.9 + Math.random() * 0.2);
    band.Q.value = p.noiseQ;
    const nEnv = ctx.createGain();
    nEnv.gain.setValueAtTime(1, now);
    nEnv.gain.exponentialRampToValueAtTime(0.001, now + p.noiseDecay);
    src.connect(band).connect(nEnv).connect(out);
    src.start(now);
    src.stop(now + p.noiseDecay + 0.02);

    p.partials.forEach((ratio, i) => {
      const osc = ctx.createOscillator();
      osc.type = p.wave;
      osc.frequency.value = p.base * pitch * ratio * (0.97 + Math.random() * 0.06);
      const env = ctx.createGain();
      const amp = 0.6 / (i + 1);
      env.gain.setValueAtTime(amp, now);
      env.gain.exponentialRampToValueAtTime(0.0001, now + p.decay / (1 + i * 0.5));
      osc.connect(env).connect(out);
      osc.start(now);
      osc.stop(end);
    });
    setTimeout(() => {
      out.disconnect();
      this.voices--;
    }, (end - now) * 1000 + 50);
  }
}
