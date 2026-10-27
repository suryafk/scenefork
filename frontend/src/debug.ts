// Dev-only event trace, readable from the page as window.__sfTrace (for browser-driven checks).
declare global {
  interface Window {
    __sfTrace?: string[];
  }
}

export function trace(...parts: unknown[]): void {
  if (!import.meta.env.DEV) return;
  const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  (window.__sfTrace ??= []).push(line);
  if (window.__sfTrace.length > 200) window.__sfTrace.shift();
}
