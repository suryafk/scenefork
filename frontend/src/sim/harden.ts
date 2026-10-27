// Worker hardening (design: Trust boundary, eng review D6). Runs before any plugin loads:
// captures postMessage for runtime code, then removes the network and messaging globals a
// plugin could reach if it ever got past the parser checks.
const BLOCKED = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'WebTransport',
  'EventSource',
  'BroadcastChannel',
  'importScripts',
  'indexedDB',
  'caches',
  'navigator',
  'location',
  'close',
  'Worker',
  'SharedWorker',
] as const;

export function hardenWorker<T>(): (message: T, transfer?: Transferable[]) => void {
  const scope = self as unknown as Record<string, unknown> & { postMessage(m: unknown, t?: Transferable[]): void };
  const post = scope.postMessage.bind(scope);
  const stub = () => {
    throw new Error('not available in the physics sandbox');
  };
  for (const name of [...BLOCKED, 'postMessage']) {
    try {
      Object.defineProperty(scope, name, { value: stub, writable: false, configurable: false });
    } catch {
      // Some globals are non-configurable in some engines; the parser allowlist still blocks them.
    }
  }
  return post as (message: T, transfer?: Transferable[]) => void;
}
