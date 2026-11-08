import type { ZodTypeAny, output } from 'zod';
import { AppError } from './errors';

export function parseBody<T extends ZodTypeAny>(schema: T, body: unknown): output<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError(
      400,
      'validation_failed',
      'Some fields are invalid.',
      result.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'body',
        message: issue.message,
      })),
    );
  }
  return result.data;
}
