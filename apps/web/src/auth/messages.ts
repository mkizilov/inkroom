import type { ZodError } from 'zod';
import { ApiError } from '../api/client';

export interface ErrorDetail {
  field: string;
  message: string;
}

export type FieldErrors = Partial<Record<string, string>>;

const messages: Record<string, string> = {
  invalid_credentials: 'Email or password is incorrect.',
  email_taken: 'An account with this email already exists. Try signing in instead.',
  rate_limited: 'Too many attempts. Wait a few minutes before trying again.',
  csrf_origin_rejected: 'This request was blocked for your safety. Reload and try again.',
  network_error: 'Could not reach the server. Check your connection and try again.',
  session_expired: 'Your session has expired. Sign in again.',
  session_revoked: 'You have been signed out. Sign in again.',
};

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return messages[error.code] ?? error.message;
  }
  return 'Something went wrong. Try again.';
}

export function fieldErrorsFrom(error: ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    errors[issue.path.join('.')] ??= issue.message;
  }
  return errors;
}
