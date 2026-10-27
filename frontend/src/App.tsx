import { useEffect, useRef, useState } from 'react';
import { trace } from './debug';
import { ProceduralAudio } from './audio/ProceduralAudio';
import { Hud, type HudStats } from './components/Hud';
import { VideoPanel } from './components/VideoPanel';
import { ForkController, captureFrame } from './fork/ForkController';
import { BackendClient, demoKey, type ConnStatus } from './net/BackendClient';
import { SceneRenderer } from './render/SceneRenderer';
import { HEIGHT, WIDTH, paintFullFrame, paintPlate, syntheticManifest } from './scene/syntheticScene';
import { PhysicsClient } from './sim/PhysicsClient';

const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? 'http://localhost:8000';

type Mode = 'demo' | 'fork';

interface Engine {
  renderer: SceneRenderer;
  physics: PhysicsClient;
  backend: BackendClient;
  fork: ForkController;
}

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const modeRef = useRef<Mode>('demo');
  const audioRef = useRef(new ProceduralAudio());
  const [mode, setMode] = useState<Mode>('demo');
  const [stats, setStats] = useState<HudStats>({ fps: 0, stepMs: 0, bodies: 0, held: null, impacts: 0, spend: null, lastFreeMs: null });
  const [xray, setXray] = useState(false);
  const [muted, setMuted] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conn, setConn] = useState<ConnStatus>('connecting');
  const [live, setLive] = useState<boolean | null>(null);

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
      toastTimer = setTimeout(() => setToast(null), 3500);
    };

    // The worker and socket handlers reach the controller through this binding.
    let fork: ForkController | null = null;
    const physics = new PhysicsClient({
      ready: (ids, geometry) => {
        labels.clear();
        geometry.forEach((g) => labels.set(g.id, g.label));
        bodies = ids.length;
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
      error: setError,
    });
    const backend = new BackendClient(
      BACKEND_URL,
      demoKey(),
      (m) => {
        if (m.type === 'hello') setLive(m.live);
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
    const controller = fork;

    renderer.init(host, WIDTH, HEIGHT).then(() => {
      initialized = true;
      // StrictMode mounts twice: a cleanup that ran mid-init leaves the destroy to us.
      if (disposed) {
        renderer.destroy();
        return;
      }
      engineRef.current = { renderer, physics, backend, fork: controller };
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
      canvas.addEventListener('pointermove', (e) => send('move', e));
      canvas.addEventListener('pointerup', (e) => send('up', e));
      canvas.addEventListener('pointercancel', (e) => send('up', e));
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
      });
    }, 250);

    return () => {
      disposed = true;
      clearInterval(statsTimer);
      clearTimeout(toastTimer);
      controller.reset();
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'x' || e.key === 'X') setXray((v) => !v);
      else if (e.key === 'm' || e.key === 'M') setMuted((v) => !v);
      else if ((e.key === 'r' || e.key === 'R') && modeRef.current === 'demo') engineRef.current?.physics.load(syntheticManifest);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
          onToggleXray={() => setXray((v) => !v)}
          onToggleMute={() => setMuted((v) => !v)}
          onReset={() => (mode === 'demo' ? engineRef.current?.physics.load(syntheticManifest) : backToDemo())}
        />
        {toast && <div className="toast">{toast}</div>}
        {error && <div className="error">Physics error: {error}</div>}
      </section>
    </main>
  );
}
