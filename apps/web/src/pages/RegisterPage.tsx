import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { MIN_PASSWORD_LENGTH, registerRequestSchema } from '@inkroom/shared';
import { useAuth } from '../auth/AuthContext';
import { describeError, fieldErrorsFrom, type FieldErrors } from '../auth/messages';
import { safeReturnPath } from '../auth/redirect';
import { TextField } from '../components/TextField';

export function RegisterPage() {
  const { state, register } = useAuth();
  const location = useLocation();
  const [displayName, setDisplayName] = useState('');
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
    const parsed = registerRequestSchema.safeParse({ displayName, email, password });
    if (!parsed.success) {
      setFieldErrors(fieldErrorsFrom(parsed.error));
      setFormError(null);
      return;
    }

    setFieldErrors({});
    setFormError(null);
    setSubmitting(true);
    try {
      await register(parsed.data);
    } catch (error) {
      setFormError(describeError(error));
      setSubmitting(false);
    }
  }

  return (
    <main>
      <h1>Create account</h1>
      <form onSubmit={handleSubmit} noValidate>
        <TextField
          id="register-name"
          label="Display name"
          name="displayName"
          autoComplete="name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          error={fieldErrors.displayName}
          disabled={submitting}
        />
        <TextField
          id="register-email"
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
          id="register-password"
          label={`Password (at least ${MIN_PASSWORD_LENGTH} characters)`}
          type="password"
          name="password"
          autoComplete="new-password"
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
          {submitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>
      <p>
        Already registered? <Link to="/login">Sign in</Link>
      </p>
    </main>
  );
}
