// Shadow-world verifier (design: Verifier). Pre-warmed: Rapier loads when the worker starts.
// It reports progress while it runs, so the main thread can kill it after 300 ms of silence
// (a plugin stuck in a loop) and swap in the spare.
import { hardenWorker } from './harden';
import { initRapier } from './SimCore';
import { verifyPlugin, type VerifyRequest, type VerifyResult } from './verifier';

export type VerifierIn = { type: 'verify'; id: number; req: VerifyRequest };
export type VerifierOut =
  | { type: 'ready' }
  | { type: 'started'; id: number }
  | { type: 'progress'; id: number }
  | { type: 'result'; id: number; result: VerifyResult };

const post = hardenWorker<VerifierOut>();
const ready = initRapier().then(() => post({ type: 'ready' }));

self.onmessage = async (e: MessageEvent<VerifierIn>) => {
  const { id, req } = e.data;
  await ready;
  post({ type: 'started', id });
  const result = verifyPlugin(req, () => post({ type: 'progress', id }));
  post({ type: 'result', id, result });
};
