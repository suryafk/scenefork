import { useEffect, useRef, useState } from 'react';
import { ProceduralAudio } from './audio/ProceduralAudio';
import { Hud, type HudStats } from './components/Hud';
import { SceneRenderer } from './render/SceneRenderer';
import { syntheticManifest } from './scene/syntheticScene';
import { PhysicsClient } from './sim/PhysicsClient';

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<SceneRenderer | null>(null);
  const physicsRef = useRef<PhysicsClient | null>(null);
  const audioRef = useRef(new ProceduralAudio());
  const [stats, setStats] = useState<HudStats>({ fps: 0, stepMs: 0, bodies: 0, held: null, impacts: 0 });
  const [xray, setXray] = useState(false);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current!;
    const renderer = new SceneRenderer();
    const manifest = syntheticManifest;
    let disposed = false;
    let impacts = 0;
    let stepMs = 0;
    let held: string | null = null;
    let labels = new Map<string, string>();

    const physics = new PhysicsClient(
      (ids, geometry) => {
        labels = new Map(geometry.map((g) => [g.id, g.label]));
        renderer.setScene(manifest, ids, geometry);
      },
      (frame) => {
        renderer.pushFrame(frame.buf);
        stepMs = frame.step_ms;
        held = frame.held;
        for (const e of frame.collisions) {
          impacts++;
          audioRef.current.impact(e);
        }
      },
      setError,
    );

    let initialized = false;
    renderer.init(host, manifest).then(() => {
      initialized = true;
      // StrictMode mounts twice: a cleanup that ran mid-init leaves the destroy to us.
      if (disposed) {
        renderer.destroy();
        return;
      }
      rendererRef.current = renderer;
      physicsRef.current = physics;
      physics.load(manifest);
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
      if (!rendererRef.current) return;
      setStats({
        fps: Math.round(renderer.app.ticker.FPS),
        stepMs,
        bodies: manifest.entities.length,
        held: held ? labels.get(held) ?? held : null,
        impacts,
      });
    }, 250);

    return () => {
      disposed = true;
      clearInterval(statsTimer);
      physics.dispose();
      rendererRef.current = null;
      physicsRef.current = null;
      if (initialized) renderer.destroy();
    };
  }, []);

  useEffect(() => {
    if (rendererRef.current) rendererRef.current.xrayOn = xray;
  }, [xray, stats]);

  useEffect(() => {
    audioRef.current.muted = muted;
  }, [muted]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'x' || e.key === 'X') setXray((v) => !v);
      else if (e.key === 'm' || e.key === 'M') setMuted((v) => !v);
      else if (e.key === 'r' || e.key === 'R') physicsRef.current?.load(syntheticManifest);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <main className="app">
      <header className="bar">
        <h1>SceneFork</h1>
        <span className="sub">Phase 1 · synthetic street · drag and throw anything</span>
      </header>
      <section className="stage">
        <div ref={hostRef} className="canvas-host" />
        <Hud
          stats={stats}
          xray={xray}
          muted={muted}
          onToggleXray={() => setXray((v) => !v)}
          onToggleMute={() => setMuted((v) => !v)}
          onReset={() => physicsRef.current?.load(syntheticManifest)}
        />
        {error && <div className="error">Physics error: {error}</div>}
      </section>
    </main>
  );
}
