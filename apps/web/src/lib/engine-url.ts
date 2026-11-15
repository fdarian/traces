const DEFAULT_ENGINE_URL = 'http://localhost:4000';

// Server-only: the browser never sees the engine origin, it goes through /api/rpc.
export function getEngineUrl(): string {
  return process.env.ENGINE_URL ?? DEFAULT_ENGINE_URL;
}
