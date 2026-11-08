import { z } from 'zod';
import {
  MAX_CANVAS_OBJECTS,
  MAX_PEN_POINTS,
  MAX_TEXT_LENGTH,
  canvasObjectSchema,
  colorSchema,
  coordinate,
  extent,
  pointSchema,
  type CanvasObject,
} from './canvas';

// Every edit to a document is expressed as operations that address objects by stable id. The same
// operations drive local undo and redo, and they are the unit that a collaborative session would
// send to other clients. Applying them is pure, so a server can replay them in the same way.

export class OperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationError';
  }
}

const objectId = z.string().uuid();

// Only fields that exist on the object's type may change; the result is validated as a whole.
export const objectChangesSchema = z
  .object({
    x: coordinate.optional(),
    y: coordinate.optional(),
    width: extent.optional(),
    height: extent.optional(),
    dx: coordinate.optional(),
    dy: coordinate.optional(),
    points: z.array(pointSchema).min(2).max(MAX_PEN_POINTS).optional(),
    text: z.string().max(MAX_TEXT_LENGTH).optional(),
    fontSize: z.number().finite().min(6).max(400).optional(),
    stroke: colorSchema.optional(),
    strokeWidth: z.number().finite().min(0.5).max(64).optional(),
    fill: colorSchema.optional(),
  })
  .strict();

export const insertOperationSchema = z.object({
  type: z.literal('insert'),
  index: z.number().int().min(0),
  objects: z.array(canvasObjectSchema).min(1).max(MAX_CANVAS_OBJECTS),
});

export const removeOperationSchema = z.object({
  type: z.literal('remove'),
  ids: z.array(objectId).min(1).max(MAX_CANVAS_OBJECTS),
});

export const updateOperationSchema = z.object({
  type: z.literal('update'),
  id: objectId,
  changes: objectChangesSchema,
});

// Lists every object id in the new z-order. It must be a permutation of the current ids.
export const reorderOperationSchema = z.object({
  type: z.literal('reorder'),
  ids: z.array(objectId).max(MAX_CANVAS_OBJECTS),
});

export const canvasOperationSchema = z.discriminatedUnion('type', [
  insertOperationSchema,
  removeOperationSchema,
  updateOperationSchema,
  reorderOperationSchema,
]);

export type ObjectChanges = z.infer<typeof objectChangesSchema>;
export type CanvasOperation = z.infer<typeof canvasOperationSchema>;

// Applies operations in order and returns a new array. Throws OperationError when an operation
// does not fit the document, for example an unknown id or an invalid resulting object.
export function applyOperations(
  objects: readonly CanvasObject[],
  operations: readonly CanvasOperation[],
): CanvasObject[] {
  return operations.reduce<CanvasObject[]>(
    (current, operation) => applyOperation(current, operation),
    [...objects],
  );
}

function applyOperation(objects: CanvasObject[], operation: CanvasOperation): CanvasObject[] {
  switch (operation.type) {
    case 'insert':
      return insertObjects(objects, operation.index, operation.objects);
    case 'remove':
      return removeObjects(objects, operation.ids);
    case 'update':
      return updateObject(objects, operation.id, operation.changes);
    case 'reorder':
      return reorderObjects(objects, operation.ids);
  }
}

function insertObjects(
  objects: CanvasObject[],
  index: number,
  inserted: CanvasObject[],
): CanvasObject[] {
  if (index > objects.length) {
    throw new OperationError(`Insert index ${index} is beyond the end of the document.`);
  }
  const seen = new Set(objects.map((object) => object.id));
  for (const object of inserted) {
    if (seen.has(object.id)) {
      throw new OperationError(`Object ${object.id} already exists.`);
    }
    seen.add(object.id);
  }
  return [...objects.slice(0, index), ...inserted, ...objects.slice(index)];
}

function removeObjects(objects: CanvasObject[], ids: string[]): CanvasObject[] {
  const present = new Set(objects.map((object) => object.id));
  for (const id of ids) {
    if (!present.has(id)) {
      throw new OperationError(`Object ${id} does not exist.`);
    }
  }
  const targets = new Set(ids);
  return objects.filter((object) => !targets.has(object.id));
}

function updateObject(
  objects: CanvasObject[],
  id: string,
  changes: ObjectChanges,
): CanvasObject[] {
  const index = objects.findIndex((object) => object.id === id);
  const target = objects[index];
  if (!target) {
    throw new OperationError(`Object ${id} does not exist.`);
  }

  const parsed = canvasObjectSchema.safeParse({ ...target, ...changes });
  if (!parsed.success) {
    const reason = parsed.error.issues[0]?.message ?? 'invalid value';
    throw new OperationError(`Update to ${id} is invalid: ${reason}.`);
  }
  // Unknown keys are stripped by the schema, so a change that does not fit the type is detected
  // here rather than silently dropped.
  for (const key of Object.keys(changes)) {
    if (!(key in parsed.data)) {
      throw new OperationError(`Field ${key} does not apply to ${target.type} objects.`);
    }
  }
  return objects.map((object, position) => (position === index ? parsed.data : object));
}

function reorderObjects(objects: CanvasObject[], ids: string[]): CanvasObject[] {
  const byId = new Map(objects.map((object) => [object.id, object] as const));
  const isPermutation =
    ids.length === objects.length &&
    new Set(ids).size === ids.length &&
    ids.every((id) => byId.has(id));
  if (!isPermutation) {
    throw new OperationError('Reorder must list every object exactly once.');
  }
  return ids.map((id) => {
    const object = byId.get(id);
    if (!object) {
      throw new OperationError(`Object ${id} does not exist.`);
    }
    return object;
  });
}

// Returns the operations that turn `before` into `after`. Applying them to `before` gives `after`
// exactly, and diffDocuments(after, before) gives the inverse, which is what undo applies.
// Objects that change type or lose a field are replaced (remove and insert), because an update
// cannot express a removed field.
export function diffDocuments(
  before: readonly CanvasObject[],
  after: readonly CanvasObject[],
): CanvasOperation[] {
  const previousById = new Map(before.map((object) => [object.id, object] as const));
  const kept = new Set<string>();
  const updates: CanvasOperation[] = [];

  for (const object of after) {
    const previous = previousById.get(object.id);
    if (!previous || !sameShape(previous, object)) {
      continue;
    }
    kept.add(object.id);
    const changes = changesBetween(previous, object);
    if (Object.keys(changes).length > 0) {
      updates.push({ type: 'update', id: object.id, changes });
    }
  }

  const operations: CanvasOperation[] = [];
  const removed = before.filter((object) => !kept.has(object.id)).map((object) => object.id);
  if (removed.length > 0) {
    operations.push({ type: 'remove', ids: removed });
  }

  // Insert in ascending final position. Each insert then lands at its final index, because every
  // earlier position already holds either a kept object or an earlier insert.
  const order = before.filter((object) => kept.has(object.id)).map((object) => object.id);
  after.forEach((object, index) => {
    if (kept.has(object.id)) {
      return;
    }
    operations.push({ type: 'insert', index, objects: [object] });
    order.splice(index, 0, object.id);
  });

  operations.push(...updates);

  // Kept objects may have changed relative order, which inserts cannot express.
  const finalOrder = after.map((object) => object.id);
  if (order.some((id, index) => id !== finalOrder[index])) {
    operations.push({ type: 'reorder', ids: finalOrder });
  }
  return operations;
}

function definedKeys(object: CanvasObject): string[] {
  const record: Record<string, unknown> = object;
  return Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
}

function sameShape(a: CanvasObject, b: CanvasObject): boolean {
  return a.type === b.type && JSON.stringify(definedKeys(a)) === JSON.stringify(definedKeys(b));
}

function changesBetween(previous: CanvasObject, next: CanvasObject): ObjectChanges {
  const before: Record<string, unknown> = previous;
  const after: Record<string, unknown> = next;
  const changed: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (key === 'id' || key === 'type') {
      continue;
    }
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changed[key] = after[key];
    }
  }
  return objectChangesSchema.parse(changed);
}
