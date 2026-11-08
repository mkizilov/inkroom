import type { ZodTypeAny, output } from 'zod';
import { AppError } from './errors';

function parseWith<T extends ZodTypeAny>(schema: T, value: unknown, source: string): output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(
      400,
      'validation_failed',
      'Some fields are invalid.',
      result.error.issues.map((issue) => ({
        field: issue.path.join('.') || source,
        message: issue.message,
      })),
    );
  }
  return result.data;
}

export function parseBody<T extends ZodTypeAny>(schema: T, body: unknown): output<T> {
  return parseWith(schema, body, 'body');
}

export function parseQuery<T extends ZodTypeAny>(schema: T, query: unknown): output<T> {
  return parseWith(schema, query, 'query');
}

export function parseParams<T extends ZodTypeAny>(schema: T, params: unknown): output<T> {
  return parseWith(schema, params, 'params');
}
