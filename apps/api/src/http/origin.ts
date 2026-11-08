import type { FastifyRequest } from 'fastify';
import { AppError } from './errors';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Every state-changing API request must come from the web origin. Browsers always send Origin on
// cross-site and fetch requests, so a missing or foreign value is rejected.
export function requireTrustedOrigin(webOrigin: string) {
  return async (request: FastifyRequest): Promise<void> => {
    if (!request.url.startsWith('/api/') || SAFE_METHODS.has(request.method)) {
      return;
    }
    if (request.headers.origin !== webOrigin) {
      throw new AppError(
        403,
        'csrf_origin_rejected',
        'This request came from an untrusted origin.',
      );
    }
  };
}
