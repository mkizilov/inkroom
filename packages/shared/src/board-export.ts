import { z } from 'zod';
import { boardTitleSchema } from './boards';
import {
  canvasObjectSchema,
  coordinate,
  extent,
  MAX_CANVAS_OBJECTS,
  type CanvasObject,
} from './canvas';

// A board's objects as a versioned JSON file. Export writes it and import reads it. A reader accepts
// only the versions it knows, so a file from a newer version is refused rather than misread.
export const BOARD_EXPORT_FORMAT = 'inkroom.board';
export const BOARD_EXPORT_VERSION = 1;

// The largest file import accepts, and the largest JSON export produces.
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

export const regionSchema = z.object({
  x: coordinate,
  y: coordinate,
  width: extent,
  height: extent,
});

export type Region = z.infer<typeof regionSchema>;

export const boardExportSchema = z
  .object({
    format: z.literal(BOARD_EXPORT_FORMAT),
    version: z.literal(BOARD_EXPORT_VERSION),
    title: boardTitleSchema,
    exportedAt: z.string().datetime(),
    // The area that was exported, or null for the whole board. An import always keeps the objects at
    // the coordinates they were exported with, so this records the area for the reader.
    region: regionSchema.nullable(),
    // Back to front. The order of this array is the stacking order.
    objects: z.array(canvasObjectSchema).max(MAX_CANVAS_OBJECTS),
  })
  .strict()
  .superRefine((document, context) => {
    const seen = new Set<string>();
    document.objects.forEach((object, index) => {
      if (seen.has(object.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Object ids must be unique.',
          path: ['objects', index, 'id'],
        });
      }
      seen.add(object.id);
    });
  });

export type BoardExport = z.infer<typeof boardExportSchema>;

export interface BoardExportInput {
  title: string;
  objects: readonly CanvasObject[];
  region: Region | null;
  exportedAt: string;
}

// The file text for a board. The document is checked against the schema first, so an export never
// holds anything that import would refuse.
export function serializeBoardExport(input: BoardExportInput): string {
  return JSON.stringify(
    boardExportSchema.parse({
      format: BOARD_EXPORT_FORMAT,
      version: BOARD_EXPORT_VERSION,
      ...input,
    }),
  );
}

// Reads a file's text. Throws a SyntaxError when the text is not JSON, and a ZodError when the JSON is
// not a valid board export of a version this code reads.
export function parseBoardExport(text: string): BoardExport {
  return boardExportSchema.parse(JSON.parse(text));
}
