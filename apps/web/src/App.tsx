import { useEffect, useState } from 'react';
import { healthResponseSchema, type HealthResponse } from '@inkroom/shared';

type ApiState =
  | { kind: 'loading' }
  | { kind: 'loaded'; health: HealthResponse }
  | { kind: 'unreachable'; message: string };

export function App() {
  const [api, setApi] = useState<ApiState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();

    fetch('/api/health', { signal: controller.signal })
      .then(async (response) => healthResponseSchema.parse(await response.json()))
      .then((health) => setApi({ kind: 'loaded', health }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        const message = error instanceof Error ? error.message : 'Unknown error';
        setApi({ kind: 'unreachable', message });
      });

    return () => controller.abort();
  }, []);

  return (
    <main>
      <h1>InkRoom</h1>
      <p>Collaborative whiteboard. Setup stage: whiteboard features are not built yet.</p>
      <section aria-live="polite" aria-label="API status">
        {api.kind === 'loading' && <p>API status: checking…</p>}
        {api.kind === 'loaded' && (
          <p>
            API status: {api.health.status} (database: {api.health.database})
          </p>
        )}
        {api.kind === 'unreachable' && <p>API unreachable: {api.message}</p>}
      </section>
    </main>
  );
}
