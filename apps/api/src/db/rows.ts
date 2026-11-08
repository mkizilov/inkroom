export function firstRow<T>(rows: readonly T[], label: string): T {
  const [row] = rows;
  if (!row) {
    throw new Error(`Expected a row from ${label}`);
  }
  return row;
}
