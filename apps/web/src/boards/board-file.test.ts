import { describe, expect, it } from 'vitest';
import { serializeBoardExport } from '@inkroom/shared';
import { readBoardFile } from './board-file';

const exported = serializeBoardExport({
  title: 'Imported',
  objects: [],
  region: null,
  exportedAt: '2026-01-02T09:30:00.000Z',
});

describe('readBoardFile', () => {
  it('accepts an export and returns its document', () => {
    const result = readBoardFile(exported);

    expect('document' in result && result.document.title).toBe('Imported');
  });

  it('refuses text that is not JSON', () => {
    expect(readBoardFile('{"format":')).toEqual({ error: 'This file is not valid JSON.' });
  });

  it('refuses a version it does not read, and says which version it is', () => {
    const future = JSON.stringify({ ...JSON.parse(exported), version: 2 });

    const result = readBoardFile(future);

    expect('error' in result && result.error).toContain('version 2');
  });

  it('refuses a file that is not a board export, and says where the problem is', () => {
    const result = readBoardFile(JSON.stringify({ format: 'something-else', version: 1 }));

    expect('error' in result && result.error).toMatch(/^This is not a valid InkRoom board export/);
  });
});
