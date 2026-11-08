import { z } from 'zod';

// Coordinates are world units. The viewport (zoom and pan) is client state and is never stored
// here, so a saved document looks the same at every zoom level.
export const CANVAS_FORMAT_VERSION = 1;
export const MAX_CANVAS_OBJECTS = 10_000;
export const MAX_PEN_POINTS = 10_000;
export const MAX_TEXT_LENGTH = 5_000;

const COORDINATE_LIMIT = 1e7;

const coordinate = z.number().finite().min(-COORDINATE_LIMIT).max(COORDINATE_LIMIT);
const extent = z.number().finite().min(0).max(COORDINATE_LIMIT);
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a 6-digit hex color.');

export const pointSchema = z.object({
  x: coordinate,
  y: coordinate,
});

const objectBase = {
  id: z.string().uuid(),
  x: coordinate,
  y: coordinate,
  stroke: colorSchema,
  strokeWidth: z.number().finite().min(0.5).max(64),
};

// Pen points are relative to the object's x and y, so moving an object only changes x and y.
export const penObjectSchema = z.object({
  ...objectBase,
  type: z.literal('pen'),
  points: z.array(pointSchema).min(2).max(MAX_PEN_POINTS),
});

export const rectangleObjectSchema = z.object({
  ...objectBase,
  type: z.literal('rectangle'),
  width: extent,
  height: extent,
  fill: colorSchema.optional(),
});

export const ellipseObjectSchema = z.object({
  ...objectBase,
  type: z.literal('ellipse'),
  width: extent,
  height: extent,
  fill: colorSchema.optional(),
});

// The end point is relative to the object's x and y.
export const lineObjectSchema = z.object({
  ...objectBase,
  type: z.literal('line'),
  dx: coordinate,
  dy: coordinate,
});

export const arrowObjectSchema = z.object({
  ...objectBase,
  type: z.literal('arrow'),
  dx: coordinate,
  dy: coordinate,
});

// For text, `stroke` is the text colour.
export const textObjectSchema = z.object({
  ...objectBase,
  type: z.literal('text'),
  text: z.string().max(MAX_TEXT_LENGTH),
  fontSize: z.number().finite().min(6).max(400),
});

export const canvasObjectSchema = z.discriminatedUnion('type', [
  penObjectSchema,
  rectangleObjectSchema,
  ellipseObjectSchema,
  lineObjectSchema,
  arrowObjectSchema,
  textObjectSchema,
]);

export const canvasDocumentSchema = z
  .object({
    version: z.literal(CANVAS_FORMAT_VERSION),
    objects: z.array(canvasObjectSchema).max(MAX_CANVAS_OBJECTS),
  })
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

export type Point = z.infer<typeof pointSchema>;
export type PenObject = z.infer<typeof penObjectSchema>;
export type RectangleObject = z.infer<typeof rectangleObjectSchema>;
export type EllipseObject = z.infer<typeof ellipseObjectSchema>;
export type LineObject = z.infer<typeof lineObjectSchema>;
export type ArrowObject = z.infer<typeof arrowObjectSchema>;
export type TextObject = z.infer<typeof textObjectSchema>;
export type CanvasObject = z.infer<typeof canvasObjectSchema>;
export type CanvasObjectType = CanvasObject['type'];
export type CanvasDocument = z.infer<typeof canvasDocumentSchema>;

// Validates before writing, so invalid objects can never be serialized.
export function serializeCanvasDocument(objects: readonly CanvasObject[]): string {
  const document = canvasDocumentSchema.parse({ version: CANVAS_FORMAT_VERSION, objects });
  return JSON.stringify(document);
}

// Throws a ZodError for malformed JSON, unknown object types, invalid values or duplicate ids.
export function parseCanvasDocument(json: string): CanvasDocument {
  return canvasDocumentSchema.parse(JSON.parse(json));
}
