import { apiErrorSchema } from '@inkroom/shared';
import type { ErrorDetail } from '../auth/messages';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
}

// Returns the parsed JSON body, or undefined for 204. Callers validate the payload with a schema.
export async function apiRequest(path: string, options: RequestOptions = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError(0, 'network_error', 'Could not reach the server.');
  }

  if (response.status === 204) {
    return undefined;
  }

  // A body that is not JSON (for example a proxy error page) is handled by the checks below.
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ApiError(
        response.status,
        'unexpected_response',
        'Unexpected response from the server.',
      );
    }
    const { code, message, details } = parsed.data.error;
    throw new ApiError(response.status, code, message, details);
  }
  return payload;
}
