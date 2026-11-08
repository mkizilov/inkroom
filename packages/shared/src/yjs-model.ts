import * as Y from 'yjs';
import { canvasObjectSchema, type CanvasObject } from './canvas';
import { OperationError, type CanvasOperation, type ObjectChanges } from './canvas-operations';

// Yjs representation of a board's objects. The typed model in @inkroom/shared stays the contract:
// this module converts between that model and Yjs in both directions.
//
// Layout:
//   objects: Y.Map<id, Y.Map<field, value>>
//     every field is a Y.Map entry, except `text`, which is a Y.Text so concurrent edits merge
//     `z` is the object's position in the z-order; it is dense (0..n-1) after every local write
//
// Values read from Yjs are shared with the document. Callers must not mutate them.

export const OBJECTS_KEY = 'objects';
const ORDER_FIELD = 'z';
const TEXT_FIELD = 'text';

export type ObjectMap = Y.Map<unknown>;
export type ObjectsMap = Y.Map<ObjectMap>;

export function objectsMapOf(doc: Y.Doc): ObjectsMap {
  return doc.getMap<ObjectMap>(OBJECTS_KEY);
}

interface OrderedEntry {
  id: string;
  map: ObjectMap;
  z: number;
}

function compareEntries(a: OrderedEntry, b: OrderedEntry): number {
  if (a.z !== b.z) {
    return a.z < b.z ? -1 : 1;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? -1 : 1;
}

function orderedEntries(objects: ObjectsMap): OrderedEntry[] {
  const entries: OrderedEntry[] = [];
  objects.forEach((map, id) => {
    const z = map.get(ORDER_FIELD);
    entries.push({ id, map, z: typeof z === 'number' ? z : Number.POSITIVE_INFINITY });
  });
  return entries.sort(compareEntries);
}

// Writes an object as a new entry. The caller is responsible for z-order (see writeOperations).
export function writeObject(objects: ObjectsMap, object: CanvasObject): void {
  if (objects.has(object.id)) {
    throw new OperationError(`Object ${object.id} already exists.`);
  }
  const map: ObjectMap = new Y.Map<unknown>();
  objects.set(object.id, map);

  const fields: Record<string, unknown> = object;
  for (const key of Object.keys(fields)) {
    if (key === 'id') {
      continue;
    }
    const value = fields[key];
    if (key === TEXT_FIELD && typeof value === 'string') {
      const text = new Y.Text();
      map.set(TEXT_FIELD, text);
      if (value.length > 0) {
        text.insert(0, value);
      }
    } else {
      map.set(key, value);
    }
  }
}

// Converts one entry back to the typed model. Returns null if the entry is not a valid object,
// so a malformed remote entry cannot crash the editor.
export function readObject(id: string, map: ObjectMap): CanvasObject | null {
  const record: Record<string, unknown> = { id };
  map.forEach((value, key) => {
    if (key === ORDER_FIELD) {
      return;
    }
    record[key] = value instanceof Y.Text ? value.toString() : value;
  });
  const parsed = canvasObjectSchema.safeParse(record);
  return parsed.success ? parsed.data : null;
}

export interface OrderedObjects {
  objects: CanvasObject[];
  invalidIds: string[];
}

// The objects in z-order. Entries with a missing or duplicate order sort by id, so every replica
// that holds the same state reads the same order.
export function readOrderedObjects(objects: ObjectsMap): OrderedObjects {
  const result: OrderedObjects = { objects: [], invalidIds: [] };
  for (const entry of orderedEntries(objects)) {
    const object = readObject(entry.id, entry.map);
    if (object) {
      result.objects.push(object);
    } else {
      result.invalidIds.push(entry.id);
    }
  }
  return result;
}

function readOrderedIds(objects: ObjectsMap): string[] {
  return orderedEntries(objects).map((entry) => entry.id);
}

// Replaces the text with the smallest change between the old and new values: the common prefix
// and suffix are kept, so concurrent edits elsewhere in the text survive.
function replaceText(target: Y.Text, next: string): void {
  const current = target.toString();
  let start = 0;
  while (start < current.length && start < next.length && current[start] === next[start]) {
    start += 1;
  }
  let currentEnd = current.length;
  let nextEnd = next.length;
  while (currentEnd > start && nextEnd > start && current[currentEnd - 1] === next[nextEnd - 1]) {
    currentEnd -= 1;
    nextEnd -= 1;
  }
  if (currentEnd > start) {
    target.delete(start, currentEnd - start);
  }
  if (nextEnd > start) {
    target.insert(start, next.slice(start, nextEnd));
  }
}

function updateFields(map: ObjectMap, changes: ObjectChanges): void {
  const fields: Record<string, unknown> = changes;
  for (const key of Object.keys(fields)) {
    const value = fields[key];
    if (key === TEXT_FIELD && typeof value === 'string') {
      const text = map.get(TEXT_FIELD);
      if (!(text instanceof Y.Text)) {
        throw new OperationError('Text objects must store their text in a Y.Text.');
      }
      replaceText(text, value);
    } else {
      map.set(key, value);
    }
  }
}

function renumber(objects: ObjectsMap, order: readonly string[]): void {
  order.forEach((id, index) => {
    const map = objects.get(id);
    if (map && map.get(ORDER_FIELD) !== index) {
      map.set(ORDER_FIELD, index);
    }
  });
}

// Writes operations into the objects map. Call this inside a Yjs transaction. The operations are
// interpreted exactly as applyOperations interprets them, so the result matches the typed model.
export function writeOperations(objects: ObjectsMap, operations: readonly CanvasOperation[]): void {
  let order = readOrderedIds(objects);
  for (const operation of operations) {
    switch (operation.type) {
      case 'insert':
        operation.objects.forEach((object, offset) => {
          writeObject(objects, object);
          order.splice(operation.index + offset, 0, object.id);
        });
        break;
      case 'remove': {
        for (const id of operation.ids) {
          if (!objects.has(id)) {
            throw new OperationError(`Object ${id} does not exist.`);
          }
        }
        for (const id of operation.ids) {
          objects.delete(id);
        }
        const removed = new Set(operation.ids);
        order = order.filter((id) => !removed.has(id));
        break;
      }
      case 'update': {
        const map = objects.get(operation.id);
        if (!map) {
          throw new OperationError(`Object ${operation.id} does not exist.`);
        }
        updateFields(map, operation.changes);
        break;
      }
      case 'reorder': {
        const known = new Set(order);
        const isPermutation =
          operation.ids.length === order.length &&
          new Set(operation.ids).size === order.length &&
          operation.ids.every((id) => known.has(id));
        if (!isPermutation) {
          throw new OperationError('Reorder must list every object exactly once.');
        }
        order = [...operation.ids];
        break;
      }
    }
  }
  renumber(objects, order);
}

// Problems that would make two replicas disagree or the editor misbehave. An empty list means the
// document is consistent. Used by tests and available for diagnostics.
export function consistencyProblems(objects: ObjectsMap): string[] {
  const problems: string[] = [];
  orderedEntries(objects).forEach((entry, index) => {
    if (entry.z !== index) {
      problems.push(`object ${entry.id} has order ${entry.z}, expected ${index}`);
    }
  });
  for (const id of readOrderedObjects(objects).invalidIds) {
    problems.push(`object ${id} is not a valid canvas object`);
  }
  return problems;
}
