import { MAX_IMPORT_BYTES, serializeBoardExport, type Region } from '@inkroom/shared';
import { renderPng } from './png';
import type { ExportScope, ExportSelection } from './regions';
import { renderSvg } from './svg';

// A file could not be made. The message is shown to the user as it is.
export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

// The most pixels a PNG may have: 5000 by 5000, about 100 MB of memory in the browser.
export const MAX_PNG_PIXELS = 25_000_000;

// Why a PNG of this region and scale cannot be made, or null when it can.
export function pngSizeError(region: Region, scale: number): string | null {
  const pixels = Math.round(region.width * scale) * Math.round(region.height * scale);
  if (pixels > MAX_PNG_PIXELS) {
    return `This picture would be ${pixels.toLocaleString('en-US')} pixels. Choose a smaller region or a lower scale.`;
  }
  return null;
}

// The JSON file's text. It must fit the import limit, so every export can be imported again.
export function buildJsonText(
  title: string,
  selection: ExportSelection,
  exportedAt: string,
): string {
  const text = serializeBoardExport({
    title,
    objects: selection.objects,
    region: selection.recordedRegion,
    exportedAt,
  });
  if (new Blob([text]).size > MAX_IMPORT_BYTES) {
    const limit = MAX_IMPORT_BYTES / (1024 * 1024);
    throw new ExportError(
      `This export is larger than ${limit} MB, the most InkRoom can import again. Export a region or a selection instead.`,
    );
  }
  return text;
}

export function buildSvgText(title: string, selection: ExportSelection): string {
  return renderSvg(selection.objects, selection.viewport, title);
}

export async function buildPngBlob(
  title: string,
  selection: ExportSelection,
  scale: number,
): Promise<Blob> {
  const problem = pngSizeError(selection.viewport, scale);
  if (problem !== null) {
    throw new ExportError(problem);
  }
  return renderPng(buildSvgText(title, selection), selection.viewport, scale);
}

// A file name from the board's title, such as "sprint-4-selection.png".
export function exportFileName(title: string, scope: ExportScope, extension: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const suffix = scope === 'board' ? '' : `-${scope}`;
  return `${slug || 'board'}${suffix}.${extension}`;
}
