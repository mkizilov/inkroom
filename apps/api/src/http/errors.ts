import type { FastifyInstance } from 'fastify';
import type { ApiErrorBody } from '@inkroom/shared';

export interface ErrorDetail {
  field: string;
  message: string;
}

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: ErrorDetail[],
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorBody(code: string, message: string, details?: ErrorDetail[]): ApiErrorBody {
  return { error: { code, message, details } };
}

export function registerErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      if (error.headers) {
        reply.headers(error.headers);
      }
      return reply.code(error.statusCode).send(errorBody(error.code, error.message, error.details));
    }
    if (error.statusCode !== undefined && error.statusCode < 500) {
      return reply.code(error.statusCode).send(errorBody('invalid_request', error.message));
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send(errorBody('internal_error', 'Something went wrong. Try again.'));
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(errorBody('not_found', `No route for ${request.method} ${request.url}`)),
  );
}
