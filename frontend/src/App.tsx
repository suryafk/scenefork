import { useEffect, useRef, useState } from 'react';
import { trace } from './debug';
import { ProceduralAudio } from './audio/ProceduralAudio';
import { Hud, type HudStats } from './components/Hud';
import { VideoPanel } from './components/VideoPanel';
import { VoiceBar } from './components/VoiceBar';
import { ForkController, captureFrame } from './fork/ForkController';
import { BackendClient, demoKey, type ConnStatus } from './net/BackendClient';
import { SceneRenderer } from './render/SceneRenderer';
import { HEIGHT, WIDTH, paintFullFrame, paintPlate, syntheticManifest } from './scene/syntheticScene';
import { PhysicsClient } from './sim/PhysicsClient';
import { VerifierClient } from './sim/VerifierClient';
import type { RuleInfo } from './sim/rules';
import { DeicticTracker } from './voice/DeicticTracker';
import { RuleController, type CodegenReply, type MutatorLogEntry } from './voice/RuleController';
import { VoiceCapture } from './voice/VoiceCapture';

const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? 'http://localhost:8000';
const CODEGEN_TIMEOUT_MS = 30_000;
const LOG_LINES = 5;

type Mode = 'demo' | 'fork';

interface Engine {
  renderer: SceneRenderer;
  physics: PhysicsClient;
  backend: BackendClient;
  fork: ForkController;
  rules: RuleController;
  tracker: DeicticTracker;
  voice: VoiceCapture;
}

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const modeRef = useRef<Mode>('demo');
  const audioRef = useRef(new ProceduralAudio());
  const [mode, setMode] = useState<Mode>('demo');
  const [stats, setStats] = useState<HudStats>({ fps: 0, stepMs: 0, bodies: 0, held: null, impacts: 0, spend: null, lastFreeMs: null, verifierKills: 0, restarts: 0 });
  const [xray, setXray] = useState(false);
  const [muted, setMuted] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conn, setConn] = useState<ConnStatus>('connecting');
  const [live, setLive] = useState<boolean | null>(null);
  const [rules, setRules] = useState<RuleInfo[]>([]);
  const [log, setLog] = useState<MutatorLogEntry[]>([]);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [building, setBuilding] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);

  useEffect(() => {
    const host = hostRef.current!;
    const renderer = new SceneRenderer();
    const labels = new Map<string, string>();
    let disposed = false;
    let initialized = false;
    let impacts = 0;
    let stepMs = 0;
    let bodies = 0;
    let held: string | null = null;
    let spend: { total: number; cap: number } | null = null;
    let lastFreeMs: number | null = null;
    let toastTimer: ReturnType<typeof setTimeout> | undefined;
    const showToast = (text: string) => {
      setToast(text);
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => setToast(null), 4000);
    };
    const pushLog = (entry: MutatorLogEntry) => {
      trace('[rules]', entry.stage, entry.text, entry.detail);
      setLog((prev) => [entry, ...prev.filter((e) => e.id !== entry.id)].slice(0, LOG_LINES));
    };

    // The worker and socket handlers reach the controllers through these bindings.
    let fork: ForkController | null = null;
    const physics = new PhysicsClient({
      ready: (ids, geometry) => {
        labels.clear();
        geometry.forEach((g) => labels.set(g.id, g.label));
        bodies = ids.length;
        setRules([]);
        if (modeRef.current === 'demo') renderer.setScene(syntheticManifest, ids, geometry);
      },
      added: (id, geometry) => {
        trace('[physics] added', id);
        bodies++;
        fork?.added(id, geometry);
      },
      frame: (frame) => {
        renderer.pushFrame(frame.buf);
        stepMs = frame.step_ms;
        held = frame.held;
        for (const e of frame.collisions) {
          impacts++;
          audioRef.current.impact(e);
        }
      },
      grab: (g) => {
        if (g.id === null && modeRef.current === 'fork') fork?.click(g.x, g.y);
      },
      rules: (active, events, logs) => {
        setRules(active);
        for (const e of events) {
          trace('[rules] event', e.kind, e.rule, e.detail);
          if (e.kind === 'evicted') showToast(`Removed ${e.name} to make room for ${e.detail}.`);
          // A plugin that passed the verifier can still fail live (a guard tripped): say so.
          if (e.kind === 'failed') {
            showToast(`Rule ${e.name} was removed: ${e.detail}`);
            pushLog({ id: `live_${e.rule}`, text: e.name, stage: 'failed', detail: `removed live: ${e.detail}`, attempt: 0, ms: 0 });
          }
        }
        for (const line of logs) trace('[plugin]', line);
      },
      restarted: (culprit, dropped) => {
        const name = dropped.find((r) => r.id === culprit)?.name ?? culprit ?? 'a plugin';
        const others = dropped.filter((r) => r.id !== culprit).map((r) => r.name);
        trace('[watchdog] restart', culprit, others);
        showToast(`Rule ${name} froze the simulation and was removed.`);
        pushLog({
          id: `freeze_${Date.now()}`,
          text: name,
          stage: 'failed',
          detail: `froze the sim; restarted from the last snapshot${others.length ? `, also unloaded ${others.join(', ')}` : ''}`,
          attempt: 0,
          ms: 0,
        });
      },
      error: setError,
    });
    const verifier = new VerifierClient();
    const pendingCodegen = new Map<string, (r: CodegenReply) => void>();
    let codegenSeq = 0;
    const backend = new BackendClient(
      BACKEND_URL,
      demoKey(),
      (m) => {
        if (m.type === 'hello') setLive(m.live);
        if (m.type === 'codegen_result' || m.type === 'codegen_failed') {
          trace('[codegen]', m.type, m.req_id, m.type === 'codegen_result' ? { ms: m.ms, cached: m.cached, problems: m.problems } : m.reason);
          pendingCodegen.get(m.req_id)?.(
            m.type === 'codegen_result' ? { ok: true, plugin: m.plugin, problems: m.problems, ms: m.ms } : { ok: false, reason: m.reason, message: m.message },
          );
          pendingCodegen.delete(m.req_id);
          return;
        }
        fork?.handle(m);
      },
      setConn,
    );
    fork = new ForkController(renderer, physics, backend, {
      toast: showToast,
      label: (id, label) => labels.set(id, label),
      spend: (total, cap) => (spend = { total, cap }),
      lastTiming: (ms) => (lastFreeMs = ms),
    });
    const ruleController = new RuleController({
      physics,
      verify: (req) => verifier.verify(req),
      codegen: (req) =>
        new Promise<CodegenReply>((resolve) => {
          const id = `cg${++codegenSeq}`;
          if (!backend.codegen(id, req)) {
            resolve({ ok: false, reason: 'offline', message: "can't reach the SceneFork backend" });
            return;
          }
          const timer = setTimeout(() => {
            pendingCodegen.delete(id);
            resolve({ ok: false, reason: 'timeout', message: `no answer from the model within ${CODEGEN_TIMEOUT_MS / 1000} s` });
          }, CODEGEN_TIMEOUT_MS);
          pendingCodegen.set(id, (r) => {
            clearTimeout(timer);
            resolve(r);
          });
        }),
      log: pushLog,
      toast: showToast,
    });
    const tracker = new DeicticTracker((x, y) => renderer.entityAt(x, y));
    const runCommand = (text: string, dwell: [string, number][], utterance?: number) => {
      setBuilding(true);
      void ruleController.command(text, dwell, utterance).finally(() => setBuilding(ruleController.building));
    };
    const voice = new VoiceCapture({
      interim: (text, startedAt) => {
        setTranscript(text);
        ruleController.interim(text, startedAt, tracker.dwell(startedAt));
      },
      final: (text, startedAt) => {
        setTranscript(text);
        runCommand(text, tracker.dwell(startedAt), startedAt);
      },
      listening: setListening,
      error: showToast,
    });
    setVoiceSupported(voice.supported);
    const controller = fork;

    renderer.init(host, WIDTH, HEIGHT).then(() => {
      initialized = true;
      // StrictMode mounts twice: a cleanup that ran mid-init leaves the destroy to us.
      if (disposed) {
        renderer.destroy();
        return;
      }
      engineRef.current = { renderer, physics, backend, fork: controller, rules: ruleController, tracker, voice };
      if (import.meta.env.DEV) {
        // Browser-driven checks: commands without a mic, and raw access for sandbox failure tests.
        Object.assign(window, { __sfCommand: (t: string) => runCommand(t, tracker.dwell(performance.now() - 3000)), __sfDebug: { physics, verifier } });
      }
      renderer.reset(WIDTH, HEIGHT, paintPlate());
      physics.load(syntheticManifest);
      backend.connect();
      const canvas = renderer.app.canvas;
      const send = (phase: 'down' | 'move' | 'up', e: PointerEvent) => {
        const [x, y] = renderer.toFramePx(e.clientX, e.clientY);
        physics.pointer(phase, x, y);
      };
      canvas.addEventListener('pointerdown', (e) => {
        audioRef.current.unlock();
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch {
          // Synthetic or already-released pointers can't be captured; dragging still works.
        }
        send('down', e);
      });
      canvas.addEventListener('pointermove', (e) => {
        tracker.move(renderer.toFramePx(e.clientX, e.clientY));
        send('move', e);
      });
      canvas.addEventListener('pointerup', (e) => send('up', e));
      canvas.addEventListener('pointercancel', (e) => send('up', e));
      canvas.addEventListener('pointerleave', () => tracker.move(null));
    });

    const statsTimer = setInterval(() => {
      if (!engineRef.current) return;
      setStats({
        fps: Math.round(renderer.app.ticker.FPS),
        stepMs,
        bodies,
        held: held ? labels.get(held) ?? held : null,
        impacts,
        spend,
        lastFreeMs,
        verifierKills: verifier.kills,
        restarts: physics.restarts,
      });
    }, 250);

    return () => {
      disposed = true;
      clearInterval(statsTimer);
      clearTimeout(toastTimer);
      controller.reset();
      voice.dispose();
      tracker.dispose();
      verifier.dispose();
      backend.close();
      physics.dispose();
      engineRef.current = null;
      if (initialized) renderer.destroy();
    };
  }, []);

  useEffect(() => {
    if (engineRef.current) engineRef.current.renderer.xrayOn = xray;
  }, [xray, stats]);

  useEffect(() => {
    audioRef.current.muted = muted;
  }, [muted]);

  const backToDemo = () => {
    const e = engineRef.current;
    if (!e) return;
    modeRef.current = 'demo';
    setMode('demo');
    e.fork.reset();
    e.renderer.reset(WIDTH, HEIGHT, paintPlate());
    e.physics.load(syntheticManifest);
  };

  const startFork = (frame: HTMLCanvasElement, clipHash: string, tFork: number) => {
    const e = engineRef.current;
    if (!e) return;
    modeRef.current = 'fork';
    setMode('fork');
    void e.fork.start(frame, clipHash, tFork);
  };

  const submitTyped = (text: string) => {
    const e = engineRef.current;
    if (!e) return;
    setTranscript(text);
    setBuilding(true);
    // Typing takes a few seconds: "this" means what the pointer rested on before the click.
    void e.rules.command(text, e.tracker.dwell(performance.now() - 4000)).finally(() => setBuilding(e.rules.building));
  };

  useEffect(() => {
    const typing = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLButtonElement;
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat) engineRef.current?.voice.start();
      } else if (e.key === 'x' || e.key === 'X') setXray((v) => !v);
      else if (e.key === 'm' || e.key === 'M') setMuted((v) => !v);
      else if ((e.key === 'r' || e.key === 'R') && modeRef.current === 'demo') engineRef.current?.physics.load(syntheticManifest);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') engineRef.current?.voice.stop();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  return (
    <main className="app">
      <header className="bar">
        <h1>SceneFork</h1>
        <span className="sub">
          {mode === 'demo' ? 'Offline demo street · drag and throw anything' : 'Live fork · click an object to pull it out, then throw it'}
        </span>
      </header>
      <VideoPanel
        backendLive={live}
        status={conn}
        forking={false}
        onForkVideo={(video, hash) => startFork(captureFrame(video, video.videoWidth, video.videoHeight), hash, video.currentTime)}
        onForkDemoStreet={() => startFork(paintFullFrame(), 'synthetic_street_01', 0)}
        onBackToDemo={backToDemo}
      />
      <section className="stage">
        <div ref={hostRef} className="canvas-host" />
        <Hud
          stats={stats}
          xray={xray}
          muted={muted}
          mode={mode}
          rules={rules}
          log={log}
          onToggleXray={() => setXray((v) => !v)}
          onToggleMute={() => setMuted((v) => !v)}
          onReset={() => (mode === 'demo' ? engineRef.current?.physics.load(syntheticManifest) : backToDemo())}
          onRemoveRule={(id) => engineRef.current?.physics.unloadRule(id)}
          onResetRules={() => engineRef.current?.physics.resetRules()}
        />
        {toast && <div className="toast">{toast}</div>}
        {error && <div className="error">Physics error: {error}</div>}
      </section>
      <VoiceBar
        supported={voiceSupported}
        listening={listening}
        transcript={transcript}
        building={building}
        onHoldStart={() => engineRef.current?.voice.start()}
        onHoldEnd={() => engineRef.current?.voice.stop()}
        onSubmit={submitTyped}
      />
    </main>
  );
}
