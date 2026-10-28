import { useRef, useState } from 'react';
import { StaticGoldenSource, type GoldenClip } from '../golden/GoldenController';

interface Props {
  backendLive: boolean | null;
  status: string;
  onForkVideo: (video: HTMLVideoElement, clipHash: string) => void;
  onForkDemoStreet: () => void;
  onBackToDemo: () => void;
  forking: boolean;
  goldenClips: GoldenClip[];
  /** Open a golden fork point (static files, no backend). */
  onForkGolden: (clip: GoldenClip, manifestPath: string) => void;
}

const MAX_BYTES = 200 * 1024 * 1024;
const MAX_SECONDS = 30;

/** Identity for a clip without reading all of it: size, name and the first 4 MB. */
async function clipHash(file: File): Promise<string> {
  const head = await file.slice(0, 4 * 1024 * 1024).arrayBuffer();
  const meta = new TextEncoder().encode(`${file.name}|${file.size}|`);
  const buf = new Uint8Array(meta.length + head.byteLength);
  buf.set(meta);
  buf.set(new Uint8Array(head), meta.length);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

export function VideoPanel({ backendLive, status, onForkVideo, onForkDemoStreet, onBackToDemo, forking, goldenClips, onForkGolden }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [hash, setHash] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  /** The golden clip playing in the video element, if any: Fork snaps to its fork points. */
  const [golden, setGolden] = useState<GoldenClip | null>(null);

  const openGolden = (clip: GoldenClip) => {
    setProblem(null);
    if (!clip.video) return onForkGolden(clip, clip.forks[0].manifest);
    if (src?.startsWith('blob:')) URL.revokeObjectURL(src);
    setSrc(StaticGoldenSource.url(clip.video));
    setGolden(clip);
  };

  const pick = async (file: File | undefined) => {
    setProblem(null);
    if (!file) return;
    if (file.size > MAX_BYTES) return setProblem('That file is over 200 MB. Trim it to a short clip first.');
    if (src?.startsWith('blob:')) URL.revokeObjectURL(src);
    setGolden(null);
    setSrc(URL.createObjectURL(file));
    setHash(await clipHash(file));
  };

  return (
    <section className="video-panel">
      <div className="video-controls">
        <label className="file">
          Open a video
          <input type="file" accept="video/*" onChange={(e) => void pick(e.target.files?.[0])} />
        </label>
        <button onClick={onForkDemoStreet} disabled={forking}>
          Fork the demo street
        </button>
        <button onClick={onBackToDemo}>Back to offline demo</button>
        {goldenClips.map((c) => (
          <button key={c.clip_id} className="golden-btn" onClick={() => openGolden(c)} title="Pre-exported clip: plays from static files">
            ★ {c.title}
          </button>
        ))}
        <span className={`conn conn-${status}`}>
          backend: {status}
          {backendLive !== null && ` · ${backendLive ? 'live models' : 'fake models (free)'}`}
        </span>
      </div>
      {problem && <p className="problem">{problem}</p>}
      {src && (
        <div className="video-row">
          <video
            ref={videoRef}
            src={src}
            controls
            muted
            playsInline
            onLoadedMetadata={(e) => {
              if (e.currentTarget.duration > MAX_SECONDS) setProblem(`That clip is over ${MAX_SECONDS}s. Shorter clips fork faster.`);
            }}
            onError={() => setProblem("This format isn't supported. Try an MP4.")}
          />
          <button
            className="fork-btn"
            disabled={forking || (!hash && !golden)}
            onClick={() => {
              const v = videoRef.current;
              if (!v || !v.videoWidth) return setProblem("This video hasn't loaded yet.");
              v.pause();
              if (golden) {
                // Near a prepared moment: instant, from static files. Anywhere else: this exact
                // frame, freed live by the models like any other video.
                const f = StaticGoldenSource.forkFor(golden, v.currentTime);
                if (f) {
                  v.currentTime = f.t_fork;
                  return onForkGolden(golden, f.manifest);
                }
                return onForkVideo(v, `golden_${golden.clip_id}`);
              }
              onForkVideo(v, hash);
            }}
          >
            Fork this frame
          </button>
          {golden && (
            <div className="moments">
              <span>Prepared moments (instant):</span>
              {golden.forks.map((f) => (
                <button
                  key={f.fork_index}
                  onClick={() => {
                    const v = videoRef.current;
                    if (!v) return;
                    v.pause();
                    v.currentTime = f.t_fork;
                  }}
                >
                  {f.t_fork.toFixed(1)} s
                </button>
              ))}
              <span className="hint">Any other moment forks live with the models.</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
