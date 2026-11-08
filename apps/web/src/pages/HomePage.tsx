import { useEffect, useState } from 'react';
import { healthResponseSchema, type HealthResponse } from '@inkroom/shared';
import { useAuth } from '../auth/AuthContext';
import { describeError } from '../auth/messages';

type ApiHealth =
  | { kind: 'checking' }
  | { kind: 'loaded'; health: HealthResponse }
  | { kind: 'unreachable' };

export function HomePage() {
  const { state, logout } = useAuth();
  const [health, setHealth] = useState<ApiHealth>({ kind: 'checking' });
  const [signingOut, setSigningOut] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal })
      .then(async (response) => healthResponseSchema.parse(await response.json()))
      .then((health) => setHealth({ kind: 'loaded', health }))
      .catch(() => {
        if (!controller.signal.aborted) {
          setHealth({ kind: 'unreachable' });
        }
      });
    return () => controller.abort();
  }, []);

  if (state.status !== 'authenticated') {
    return null;
  }
  const { user } = state;

  async function handleLogout() {
    setSigningOut(true);
    setFormError(null);
    try {
      await logout();
    } catch (error) {
      setFormError(describeError(error));
      setSigningOut(false);
    }
  }

  return (
    <main>
      <h1>InkRoom</h1>
      <p>
        Signed in as <strong>{user.displayName}</strong> ({user.email}).
      </p>
      <p>Whiteboards are not built yet.</p>
      <section aria-live="polite" aria-label="API status">
        {health.kind === 'checking' && <p>API status: checking…</p>}
        {health.kind === 'loaded' && (
          <p>
            API status: {health.health.status} (database: {health.health.database})
          </p>
        )}
        {health.kind === 'unreachable' && <p>API unreachable</p>}
      </section>
      {formError && (
        <p role="alert" className="form-error">
          {formError}
        </p>
      )}
      <button type="button" onClick={handleLogout} disabled={signingOut}>
        {signingOut ? 'Signing out…' : 'Sign out'}
      </button>
    </main>
  );
}
