// Returns the SQLSTATE of the first driver error in the cause chain (drizzle wraps pg errors).
export function sqlStateOf(error: unknown): string | undefined {
  let current: unknown = error;
  while (current && typeof current === 'object') {
    if ('code' in current && typeof current.code === 'string') {
      return current.code;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

export const UNIQUE_VIOLATION = '23505';
