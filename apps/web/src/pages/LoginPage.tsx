import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { loginRequestSchema } from '@inkroom/shared';
import { useAuth } from '../auth/AuthContext';
import { describeError, fieldErrorsFrom, type FieldErrors } from '../auth/messages';
import { safeReturnPath } from '../auth/redirect';
import { TextField } from '../components/TextField';

export function LoginPage() {
  const { state, login } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (state.status === 'authenticated') {
    return <Navigate to={safeReturnPath(location.state)} replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = loginRequestSchema.safeParse({ email, password });
    if (!parsed.success) {
      setFieldErrors(fieldErrorsFrom(parsed.error));
      setFormError(null);
      return;
    }

    setFieldErrors({});
    setFormError(null);
    setSubmitting(true);
    try {
      await login(parsed.data);
    } catch (error) {
      setFormError(describeError(error));
      setSubmitting(false);
    }
  }

  return (
    <main id="main-content" tabIndex={-1}>
      <h1>Sign in</h1>
      <form onSubmit={handleSubmit} noValidate>
        <TextField
          id="login-email"
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={fieldErrors.email}
          disabled={submitting}
        />
        <TextField
          id="login-password"
          label="Password"
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={fieldErrors.password}
          disabled={submitting}
        />
        {formError && (
          <p role="alert" className="form-error">
            {formError}
          </p>
        )}
        <button type="submit" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p>
        No account yet? <Link to="/register">Create one</Link>
      </p>
    </main>
  );
}
