import { useEffect, useState } from 'react';
import { healthResponseSchema, type HealthResponse } from '@inkroom/shared';

type ApiHealth =
  | { kind: 'checking' }
  | { kind: 'loaded'; health: HealthResponse }
  | { kind: 'unreachable' };

export function ApiStatus() {
  const [health, setHealth] = useState<ApiHealth>({ kind: 'checking' });

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal })
      .then(async (response) => healthResponseSchema.parse(await response.json()))
      .then((parsed) => setHealth({ kind: 'loaded', health: parsed }))
      .catch(() => {
        if (!controller.signal.aborted) {
          setHealth({ kind: 'unreachable' });
        }
      });
    return () => controller.abort();
  }, []);

  return (
    <p aria-live="polite" className="api-status">
      {health.kind === 'checking' && 'API status: checking…'}
      {health.kind === 'loaded' &&
        `API status: ${health.health.status} (database: ${health.health.database})`}
      {health.kind === 'unreachable' && 'API unreachable'}
    </p>
  );
}
