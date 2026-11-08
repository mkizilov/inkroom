import {
  MAX_TEXT_LENGTH,
  diffDocuments,
  type CanvasObject,
  type CanvasOperation,
  type PenObject,
  type Point,
  type TextObject,
} from '@inkroom/shared';
import { normalizeRect, objectsInRect, pickObject, type Rect } from './geometry';
import { handleAt, resizeBox, selectionBounds, transformObjects, type Handle } from './transform';
import {
  INITIAL_VIEWPORT,
  panBy,
  screenToWorld,
  wheelViewport,
  worldLength,
  zoomAt,
  type Viewport,
  type WheelInput,
} from './viewport';

export type Tool = 'select' | 'pan' | 'pen' | 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'text';
type ShapeTool = 'rectangle' | 'ellipse' | 'line' | 'arrow';
export type LayerDirection = 'forward' | 'backward' | 'front' | 'back';

export const TOOL_SHORTCUTS: Readonly<Record<string, Tool>> = {
  v: 'select',
  h: 'pan',
  p: 'pen',
  r: 'rectangle',
  o: 'ellipse',
  l: 'line',
  a: 'arrow',
  t: 'text',
};

export const DEFAULT_STROKE = '#1f2328';
export const DEFAULT_STROKE_WIDTH = 2;
export const DEFAULT_FONT_SIZE = 24;
export const PASTE_OFFSET = 20;

// Screen-pixel tolerances. Converted to world units with the current zoom before use.
const HIT_SLOP_PX = 6;
const MIN_PEN_SPACING_PX = 1.5;
// Smallest width or height a selection can be resized to, in world units.
const MIN_BOX_SIZE = 1;

export interface ClipboardState {
  objects: CanvasObject[];
  pasteCount: number;
}

// Document writes produced by the reducer. The session applies them to the Yjs document in order.
// A write with boundary true starts a new undo step; false joins the step that is open.
export type OutboxEntry =
  | { kind: 'write'; operations: CanvasOperation[]; boundary: boolean }
  | { kind: 'undo' }
  | { kind: 'redo' };

export interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
}

// A pointer gesture. Move and resize write their preview to the document as it changes, and keep
// the starting objects so a cancel can restore them. Drawing is not written until release.
type Gesture =
  | { kind: 'pan'; startScreen: Point; startViewport: Viewport }
  | {
      kind: 'move';
      startWorld: Point;
      startObjects: CanvasObject[];
      ids: string[];
      startBox: Rect;
    }
  | {
      kind: 'resize';
      handle: Handle;
      startObjects: CanvasObject[];
      ids: string[];
      startBox: Rect;
    }
  | { kind: 'marquee'; startWorld: Point; base: string[] }
  | { kind: 'draw'; startWorld: Point };

export interface EditorState {
  // The editor's view of the document. Every change to it is also written to the document.
  objects: CanvasObject[];
  selectedIds: string[];
  viewport: Viewport;
  tool: Tool;
  spaceHeld: boolean;
  draft: CanvasObject | null;
  marquee: Rect | null;
  gesture: Gesture | null;
  editingTextId: string | null;
  clipboard: ClipboardState | null;
  outbox: OutboxEntry[];
  startsStep: boolean;
  undoState: UndoState;
}

// `makeId` is supplied by the caller, so the reducer stays pure and tests can be deterministic.
export type EditorAction =
  | { type: 'pointerDown'; screen: Point; button: number; shift: boolean; id: string }
  | { type: 'pointerMove'; screen: Point }
  | { type: 'pointerUp' }
  | { type: 'pointerCancel' }
  | { type: 'doubleClick'; screen: Point }
  | { type: 'setViewport'; viewport: Viewport }
  | { type: 'zoom'; factor: number; anchor: Point }
  | { type: 'wheel'; anchor: Point; input: WheelInput }
  | { type: 'setTool'; tool: Tool }
  | { type: 'setSpaceHeld'; held: boolean }
  | { type: 'selectAll' }
  | { type: 'clearSelection' }
  | { type: 'changeText'; id: string; text: string }
  | { type: 'finishText' }
  | { type: 'copy' }
  | { type: 'cut' }
  | { type: 'paste'; makeId: () => string }
  | { type: 'duplicate'; makeId: () => string }
  | { type: 'deleteSelected' }
  | { type: 'nudge'; dx: number; dy: number }
  | { type: 'reorder'; direction: LayerDirection }
  | { type: 'undo' }
  | { type: 'redo' }
  // The document changed outside the editor, for example through a remote update or an undo.
  | { type: 'syncObjects'; objects: CanvasObject[] };

type PointerDownAction = Extract<EditorAction, { type: 'pointerDown' }>;

export function createEditorState(): EditorState {
  return {
    objects: [],
    selectedIds: [],
    viewport: INITIAL_VIEWPORT,
    tool: 'select',
    spaceHeld: false,
    draft: null,
    marquee: null,
    gesture: null,
    editingTextId: null,
    clipboard: null,
    outbox: [],
    startsStep: true,
    undoState: { canUndo: false, canRedo: false },
  };
}

export function hitTolerance(viewport: Viewport): number {
  return worldLength(HIT_SLOP_PX, viewport);
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'pointerDown':
      return pointerDown(state, action);
    case 'pointerMove':
      return pointerMove(state, action.screen);
    case 'pointerUp':
      return endGesture(state);
    case 'pointerCancel':
      return cancelGesture(state);
    case 'doubleClick':
      return doubleClick(state, action.screen);
    case 'setViewport':
      return { ...state, viewport: action.viewport };
    case 'zoom':
      return {
        ...state,
        viewport: zoomAt(state.viewport, action.anchor, state.viewport.scale * action.factor),
      };
    case 'wheel':
      // Computed from the latest state, so back-to-back wheel events accumulate.
      return { ...state, viewport: wheelViewport(state.viewport, action.anchor, action.input) };
    case 'setTool':
      return { ...settle(state), tool: action.tool, selectedIds: [] };
    case 'setSpaceHeld':
      return { ...state, spaceHeld: action.held };
    case 'selectAll': {
      const settled = settle(state);
      return { ...settled, selectedIds: settled.objects.map((object) => object.id) };
    }
    case 'clearSelection':
      return { ...state, selectedIds: [] };
    case 'changeText':
      return changeText(state, action.id, action.text);
    case 'finishText':
      return finishText(state);
    case 'copy':
      return copySelection(settle(state));
    case 'cut': {
      const settled = settle(state);
      return deleteSelected(copySelection(settled));
    }
    case 'paste':
      return paste(settle(state), action.makeId);
    case 'duplicate':
      return duplicate(settle(state), action.makeId);
    case 'deleteSelected':
      return deleteSelected(settle(state));
    case 'nudge': {
      const settled = settle(state);
      return nudge(settled, action.dx, action.dy);
    }
    case 'reorder':
      return reorder(settle(state), action.direction);
    case 'undo':
      return requestHistory(state, 'undo');
    case 'redo':
      return requestHistory(state, 'redo');
    case 'syncObjects':
      return syncObjects(state, action.objects);
  }
}

// Ends the active text session and cancels any pointer gesture, so that a keyboard command acts
// on the committed document.
function settle(state: EditorState): EditorState {
  return cancelGesture(finishText(state));
}

// Replaces the view and queues the operations that turn `before` into `after`. Nothing is queued
// when the change is empty.
function emit(
  state: EditorState,
  before: readonly CanvasObject[],
  after: readonly CanvasObject[],
  boundary: boolean,
): EditorState {
  const operations = diffDocuments(before, after);
  if (operations.length === 0) {
    return { ...state, objects: [...after] };
  }
  return {
    ...state,
    objects: [...after],
    outbox: [...state.outbox, { kind: 'write', operations, boundary }],
    startsStep: false,
  };
}

// For writes inside a gesture or a text edit: the first write of the step starts it.
function emitStep(
  state: EditorState,
  before: readonly CanvasObject[],
  after: readonly CanvasObject[],
): EditorState {
  return emit(state, before, after, state.startsStep);
}

// For discrete actions (delete, paste, nudge, ...): each one is its own undo step.
function emitDiscrete(
  state: EditorState,
  before: readonly CanvasObject[],
  after: readonly CanvasObject[],
): EditorState {
  return emit(state, before, after, true);
}

function cancelGesture(state: EditorState): EditorState {
  const gesture = state.gesture;
  const idle = { ...state, gesture: null, draft: null, marquee: null };
  if (gesture?.kind === 'move' || gesture?.kind === 'resize') {
    // The preview was written as it changed, so cancelling writes the starting objects back. The
    // write joins the open step, so the drag leaves no separate undo step.
    return emit(idle, state.objects, gesture.startObjects, false);
  }
  return idle;
}

function pointerDown(state: EditorState, action: PointerDownAction): EditorState {
  // Middle button, the hand tool and held Space all pan, whatever the active tool is.
  if (action.button === 1 || state.spaceHeld || state.tool === 'pan') {
    return {
      ...state,
      gesture: { kind: 'pan', startScreen: action.screen, startViewport: state.viewport },
    };
  }
  if (action.button !== 0) {
    return state;
  }

  const current = finishText(state);
  const world = screenToWorld(action.screen, current.viewport);
  switch (current.tool) {
    case 'select':
      return beginSelection(current, world, action.shift);
    case 'text':
      return createText(current, action.id, world);
    case 'pen':
      return startDraft(current, penDraft(action.id, world), world);
    case 'rectangle':
    case 'ellipse':
    case 'line':
    case 'arrow':
      return startDraft(current, shapeObject(current.tool, action.id, world, world), world);
    case 'pan':
      return current;
  }
}

function beginSelection(state: EditorState, world: Point, shift: boolean): EditorState {
  const tolerance = hitTolerance(state.viewport);

  // Handles on the selection box take priority over the objects underneath them.
  const box = selectionBounds(state.objects, state.selectedIds);
  const handle = box ? handleAt(box, world, tolerance) : null;
  if (box && handle) {
    return {
      ...state,
      startsStep: true,
      gesture: {
        kind: 'resize',
        handle,
        startObjects: state.objects,
        ids: [...state.selectedIds],
        startBox: box,
      },
    };
  }

  const hit = pickObject(state.objects, world, tolerance);
  if (!hit) {
    const base = shift ? state.selectedIds : [];
    return {
      ...state,
      selectedIds: base,
      marquee: { x: world.x, y: world.y, width: 0, height: 0 },
      gesture: { kind: 'marquee', startWorld: world, base },
    };
  }

  if (shift && state.selectedIds.includes(hit.id)) {
    return { ...state, selectedIds: state.selectedIds.filter((id) => id !== hit.id) };
  }

  let selectedIds: string[];
  if (shift) {
    selectedIds = [...state.selectedIds, hit.id];
  } else if (state.selectedIds.includes(hit.id)) {
    selectedIds = state.selectedIds;
  } else {
    selectedIds = [hit.id];
  }

  const bounds = selectionBounds(state.objects, selectedIds);
  if (!bounds) {
    return state;
  }
  return {
    ...state,
    selectedIds,
    startsStep: true,
    gesture: {
      kind: 'move',
      startWorld: world,
      startObjects: state.objects,
      ids: selectedIds,
      startBox: bounds,
    },
  };
}

function createText(state: EditorState, id: string, world: Point): EditorState {
  const text: TextObject = {
    id,
    type: 'text',
    x: world.x,
    y: world.y,
    text: '',
    fontSize: DEFAULT_FONT_SIZE,
    ...baseStyle(),
  };
  const next = { ...state, selectedIds: [id], editingTextId: id, gesture: null };
  return emitDiscrete(next, state.objects, [...state.objects, text]);
}

function baseStyle() {
  return { stroke: DEFAULT_STROKE, strokeWidth: DEFAULT_STROKE_WIDTH };
}

function penDraft(id: string, origin: Point): PenObject {
  return {
    id,
    type: 'pen',
    x: origin.x,
    y: origin.y,
    points: [{ x: 0, y: 0 }],
    ...baseStyle(),
  };
}

// Shapes are described by their start and current point, so the draft is rebuilt on each move.
function shapeObject(tool: ShapeTool, id: string, start: Point, end: Point): CanvasObject {
  switch (tool) {
    case 'rectangle':
      return { id, type: 'rectangle', ...normalizeRect(start, end), ...baseStyle() };
    case 'ellipse':
      return { id, type: 'ellipse', ...normalizeRect(start, end), ...baseStyle() };
    case 'line':
      return {
        id,
        type: 'line',
        x: start.x,
        y: start.y,
        dx: end.x - start.x,
        dy: end.y - start.y,
        ...baseStyle(),
      };
    case 'arrow':
      return {
        id,
        type: 'arrow',
        x: start.x,
        y: start.y,
        dx: end.x - start.x,
        dy: end.y - start.y,
        ...baseStyle(),
      };
  }
}

function startDraft(state: EditorState, draft: CanvasObject, start: Point): EditorState {
  return {
    ...state,
    draft,
    selectedIds: [],
    startsStep: true,
    gesture: { kind: 'draw', startWorld: start },
  };
}

function pointerMove(state: EditorState, screen: Point): EditorState {
  const gesture = state.gesture;
  if (!gesture) {
    return state;
  }

  if (gesture.kind === 'pan') {
    const dx = screen.x - gesture.startScreen.x;
    const dy = screen.y - gesture.startScreen.y;
    return { ...state, viewport: panBy(gesture.startViewport, dx, dy) };
  }

  const world = screenToWorld(screen, state.viewport);
  switch (gesture.kind) {
    case 'move': {
      const dx = world.x - gesture.startWorld.x;
      const dy = world.y - gesture.startWorld.y;
      const target = {
        ...gesture.startBox,
        x: gesture.startBox.x + dx,
        y: gesture.startBox.y + dy,
      };
      const preview = transformObjects(gesture.startObjects, gesture.ids, gesture.startBox, target);
      return emitStep(state, state.objects, preview);
    }
    case 'resize': {
      const box = resizeBox(gesture.startBox, gesture.handle, world, MIN_BOX_SIZE);
      const preview = transformObjects(gesture.startObjects, gesture.ids, gesture.startBox, box);
      return emitStep(state, state.objects, preview);
    }
    case 'marquee': {
      const rect = normalizeRect(gesture.startWorld, world);
      const hits = objectsInRect(state.objects, rect).map((object) => object.id);
      return {
        ...state,
        marquee: rect,
        selectedIds: [...new Set([...gesture.base, ...hits])],
      };
    }
    case 'draw':
      return {
        ...state,
        draft: updateDraft(state.draft, gesture.startWorld, world, state.viewport),
      };
  }
}

function updateDraft(
  draft: CanvasObject | null,
  start: Point,
  world: Point,
  viewport: Viewport,
): CanvasObject | null {
  if (!draft) {
    return null;
  }
  if (draft.type === 'pen') {
    const last = draft.points[draft.points.length - 1];
    if (!last) {
      return draft;
    }
    const spacing = worldLength(MIN_PEN_SPACING_PX, viewport);
    if (Math.hypot(world.x - (draft.x + last.x), world.y - (draft.y + last.y)) < spacing) {
      return draft;
    }
    return { ...draft, points: [...draft.points, { x: world.x - draft.x, y: world.y - draft.y }] };
  }
  if (
    draft.type === 'rectangle' ||
    draft.type === 'ellipse' ||
    draft.type === 'line' ||
    draft.type === 'arrow'
  ) {
    return shapeObject(draft.type, draft.id, start, world);
  }
  return draft;
}

// Move and resize have already written their preview, so release only ends the gesture. A drawn
// shape is written now, as one new object.
function endGesture(state: EditorState): EditorState {
  const gesture = state.gesture;
  const idle = { ...state, gesture: null, draft: null, marquee: null };
  if (gesture?.kind === 'draw' && state.draft && isMeaningful(state.draft)) {
    const created = emitStep(idle, state.objects, [...state.objects, state.draft]);
    return { ...created, selectedIds: [state.draft.id] };
  }
  return idle;
}

// A click without a drag should not leave an empty shape behind.
function isMeaningful(object: CanvasObject): boolean {
  switch (object.type) {
    case 'pen':
      return object.points.length >= 2;
    case 'rectangle':
    case 'ellipse':
      return object.width > 0 && object.height > 0;
    case 'line':
    case 'arrow':
      return object.dx !== 0 || object.dy !== 0;
    case 'text':
      return true;
  }
}

function doubleClick(state: EditorState, screen: Point): EditorState {
  if (state.tool !== 'select') {
    return state;
  }
  const current = finishText(state);
  const world = screenToWorld(screen, current.viewport);
  const hit = pickObject(current.objects, world, hitTolerance(current.viewport));
  if (!hit || hit.type !== 'text') {
    return current;
  }
  return {
    ...current,
    selectedIds: [hit.id],
    editingTextId: hit.id,
    startsStep: true,
  };
}

// Text edits are written as they happen, so the document and any other replica follow typing.
// Keystrokes join the step that the text session opened.
function changeText(state: EditorState, id: string, text: string): EditorState {
  const clipped = text.slice(0, MAX_TEXT_LENGTH);
  const objects = state.objects.map((object) =>
    object.id === id && object.type === 'text' ? { ...object, text: clipped } : object,
  );
  return emitStep(state, state.objects, objects);
}

// Leaves text editing. A text object left empty is removed, so stray clicks do not leave
// invisible objects behind.
function finishText(state: EditorState): EditorState {
  if (!state.editingTextId) {
    return state;
  }
  const id = state.editingTextId;
  const target = state.objects.find((object) => object.id === id);
  const stopped = { ...state, editingTextId: null };
  if (target?.type === 'text' && target.text.trim() === '') {
    const objects = state.objects.filter((object) => object.id !== id);
    const selectedIds = state.selectedIds.filter((selected) => selected !== id);
    const removed = { ...stopped, selectedIds };
    return emit(removed, state.objects, objects, false);
  }
  return stopped;
}

function copySelection(state: EditorState): EditorState {
  const selected = new Set(state.selectedIds);
  const objects = state.objects
    .filter((object) => selected.has(object.id))
    .map((object) => structuredClone(object));
  if (objects.length === 0) {
    return state;
  }
  return { ...state, clipboard: { objects, pasteCount: 0 } };
}

function copyAt(object: CanvasObject, dx: number, dy: number, id: string): CanvasObject {
  return { ...structuredClone(object), id, x: object.x + dx, y: object.y + dy };
}

// Each paste lands one offset further from the copied position, so repeated pastes do not stack.
function paste(state: EditorState, makeId: () => string): EditorState {
  const clipboard = state.clipboard;
  if (!clipboard || clipboard.objects.length === 0) {
    return state;
  }
  const offset = PASTE_OFFSET * (clipboard.pasteCount + 1);
  const copies = clipboard.objects.map((object) => copyAt(object, offset, offset, makeId()));
  const written = emitDiscrete(state, state.objects, [...state.objects, ...copies]);
  return {
    ...written,
    selectedIds: copies.map((copy) => copy.id),
    clipboard: { ...clipboard, pasteCount: clipboard.pasteCount + 1 },
  };
}

// Copies the selection in place, leaving the clipboard alone.
function duplicate(state: EditorState, makeId: () => string): EditorState {
  const selected = new Set(state.selectedIds);
  const sources = state.objects.filter((object) => selected.has(object.id));
  if (sources.length === 0) {
    return state;
  }
  const copies = sources.map((object) => copyAt(object, PASTE_OFFSET, PASTE_OFFSET, makeId()));
  const written = emitDiscrete(state, state.objects, [...state.objects, ...copies]);
  return { ...written, selectedIds: copies.map((copy) => copy.id) };
}

function deleteSelected(state: EditorState): EditorState {
  if (state.selectedIds.length === 0) {
    return state;
  }
  const doomed = new Set(state.selectedIds);
  const objects = state.objects.filter((object) => !doomed.has(object.id));
  return { ...emitDiscrete(state, state.objects, objects), selectedIds: [] };
}

function nudge(state: EditorState, dx: number, dy: number): EditorState {
  if (state.selectedIds.length === 0) {
    return state;
  }
  const selected = new Set(state.selectedIds);
  const objects = state.objects.map((object) =>
    selected.has(object.id) ? { ...object, x: object.x + dx, y: object.y + dy } : object,
  );
  return emitDiscrete(state, state.objects, objects);
}

function reorder(state: EditorState, direction: LayerDirection): EditorState {
  if (state.selectedIds.length === 0) {
    return state;
  }
  const selected = new Set(state.selectedIds);
  return emitDiscrete(state, state.objects, reorderLayers(state.objects, selected, direction));
}

// Moves the selected objects in z-order. Forward and backward step each selected object past the
// neighbour it would cross, so a selected run keeps its internal order.
function reorderLayers(
  objects: readonly CanvasObject[],
  selected: ReadonlySet<string>,
  direction: LayerDirection,
): CanvasObject[] {
  const isSelected = (object: CanvasObject) => selected.has(object.id);
  switch (direction) {
    case 'front':
      return [...objects.filter((object) => !isSelected(object)), ...objects.filter(isSelected)];
    case 'back':
      return [...objects.filter(isSelected), ...objects.filter((object) => !isSelected(object))];
    case 'forward': {
      const result = [...objects];
      for (let index = result.length - 2; index >= 0; index -= 1) {
        const lower = result[index];
        const upper = result[index + 1];
        if (lower && upper && isSelected(lower) && !isSelected(upper)) {
          swapAt(result, index, index + 1);
        }
      }
      return result;
    }
    case 'backward': {
      const result = [...objects];
      for (let index = 1; index < result.length; index += 1) {
        const current = result[index];
        const lower = result[index - 1];
        if (current && lower && isSelected(current) && !isSelected(lower)) {
          swapAt(result, index - 1, index);
        }
      }
      return result;
    }
  }
}

function swapAt(objects: CanvasObject[], a: number, b: number): void {
  const first = objects[a];
  const second = objects[b];
  if (first && second) {
    objects[a] = second;
    objects[b] = first;
  }
}

// Undo and redo are applied by the document, not here. While a pointer gesture is in progress,
// the first undo or redo only cancels the gesture.
function requestHistory(state: EditorState, kind: 'undo' | 'redo'): EditorState {
  if (state.gesture) {
    return cancelGesture(state);
  }
  const settled = finishText(state);
  const entry: OutboxEntry = kind === 'undo' ? { kind: 'undo' } : { kind: 'redo' };
  return { ...settled, startsStep: true, outbox: [...settled.outbox, entry] };
}

// The document changed outside the editor. The view adopts it, and anything that refers to an
// object that no longer exists is dropped. An in-progress gesture ends, because its starting
// objects may be stale.
function syncObjects(state: EditorState, objects: CanvasObject[]): EditorState {
  const present = new Set(objects.map((object) => object.id));
  const editing = state.editingTextId !== null && present.has(state.editingTextId);
  return {
    ...state,
    objects: [...objects],
    selectedIds: state.selectedIds.filter((id) => present.has(id)),
    editingTextId: editing ? state.editingTextId : null,
    gesture: null,
    draft: null,
    marquee: null,
    startsStep: true,
  };
}
