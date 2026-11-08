import {
  MAX_TEXT_LENGTH,
  type CanvasObject,
  type PenObject,
  type Point,
  type TextObject,
} from '@inkroom/shared';
import { normalizeRect, objectsInRect, pickObject, type Rect } from './geometry';
import {
  INITIAL_VIEWPORT,
  panBy,
  screenToWorld,
  worldLength,
  zoomAt,
  type Viewport,
} from './viewport';

export type Tool = 'select' | 'pan' | 'pen' | 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'text';
type ShapeTool = 'rectangle' | 'ellipse' | 'line' | 'arrow';

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

// Screen-pixel tolerances. Converted to world units with the current zoom before use.
const HIT_SLOP_PX = 6;
const MIN_PEN_SPACING_PX = 1.5;

type Gesture =
  | { kind: 'pan'; startScreen: Point; startViewport: Viewport }
  | { kind: 'move'; startWorld: Point; originals: Record<string, Point> }
  | { kind: 'marquee'; startWorld: Point; base: string[] }
  | { kind: 'draw'; startWorld: Point };

export interface EditorState {
  objects: CanvasObject[];
  selectedIds: string[];
  viewport: Viewport;
  tool: Tool;
  spaceHeld: boolean;
  draft: CanvasObject | null;
  marquee: Rect | null;
  gesture: Gesture | null;
  editingTextId: string | null;
}

export type EditorAction =
  | { type: 'pointerDown'; screen: Point; button: number; shift: boolean; id: string }
  | { type: 'pointerMove'; screen: Point }
  | { type: 'pointerUp' }
  | { type: 'pointerCancel' }
  | { type: 'doubleClick'; screen: Point }
  | { type: 'setViewport'; viewport: Viewport }
  | { type: 'zoom'; factor: number; anchor: Point }
  | { type: 'setTool'; tool: Tool }
  | { type: 'setSpaceHeld'; held: boolean }
  | { type: 'deleteSelected' }
  | { type: 'clearSelection' }
  | { type: 'changeText'; id: string; text: string }
  | { type: 'finishText' };

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
      return { ...state, gesture: null, draft: null, marquee: null };
    case 'doubleClick':
      return doubleClick(state, action.screen);
    case 'setViewport':
      return { ...state, viewport: action.viewport };
    case 'zoom':
      return {
        ...state,
        viewport: zoomAt(state.viewport, action.anchor, state.viewport.scale * action.factor),
      };
    case 'setTool':
      return {
        ...finishText(state),
        tool: action.tool,
        selectedIds: [],
        draft: null,
        marquee: null,
        gesture: null,
      };
    case 'setSpaceHeld':
      return { ...state, spaceHeld: action.held };
    case 'deleteSelected':
      return removeObjects(state, new Set(state.selectedIds));
    case 'clearSelection':
      return { ...state, selectedIds: [] };
    case 'changeText':
      return changeText(state, action.id, action.text);
    case 'finishText':
      return finishText(state);
  }
}

function baseStyle() {
  return { stroke: DEFAULT_STROKE, strokeWidth: DEFAULT_STROKE_WIDTH };
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
  const hit = pickObject(state.objects, world, hitTolerance(state.viewport));

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

  return {
    ...state,
    selectedIds,
    gesture: {
      kind: 'move',
      startWorld: world,
      originals: originsOf(state.objects, selectedIds),
    },
  };
}

function originsOf(
  objects: readonly CanvasObject[],
  ids: readonly string[],
): Record<string, Point> {
  const origins: Record<string, Point> = {};
  for (const object of objects) {
    if (ids.includes(object.id)) {
      origins[object.id] = { x: object.x, y: object.y };
    }
  }
  return origins;
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
  return {
    ...state,
    objects: [...state.objects, text],
    selectedIds: [id],
    editingTextId: id,
    gesture: null,
  };
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
    case 'move':
      return moveObjects(state, gesture.startWorld, gesture.originals, world);
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

function moveObjects(
  state: EditorState,
  startWorld: Point,
  originals: Record<string, Point>,
  world: Point,
): EditorState {
  const dx = world.x - startWorld.x;
  const dy = world.y - startWorld.y;
  return {
    ...state,
    objects: state.objects.map((object) => {
      const origin = originals[object.id];
      return origin ? { ...object, x: origin.x + dx, y: origin.y + dy } : object;
    }),
  };
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

function endGesture(state: EditorState): EditorState {
  const base = { ...state, gesture: null, marquee: null, draft: null };
  if (state.gesture?.kind === 'draw' && state.draft && isMeaningful(state.draft)) {
    return { ...base, objects: [...state.objects, state.draft], selectedIds: [state.draft.id] };
  }
  return base;
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
  const world = screenToWorld(screen, state.viewport);
  const hit = pickObject(state.objects, world, hitTolerance(state.viewport));
  if (!hit || hit.type !== 'text') {
    return state;
  }
  return { ...state, selectedIds: [hit.id], editingTextId: hit.id };
}

function changeText(state: EditorState, id: string, text: string): EditorState {
  const clipped = text.slice(0, MAX_TEXT_LENGTH);
  return {
    ...state,
    objects: state.objects.map((object) =>
      object.id === id && object.type === 'text' ? { ...object, text: clipped } : object,
    ),
  };
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
    return removeObjects(stopped, new Set([id]));
  }
  return stopped;
}

function removeObjects(state: EditorState, ids: ReadonlySet<string>): EditorState {
  return {
    ...state,
    objects: state.objects.filter((object) => !ids.has(object.id)),
    selectedIds: state.selectedIds.filter((id) => !ids.has(id)),
    editingTextId:
      state.editingTextId && ids.has(state.editingTextId) ? null : state.editingTextId,
  };
}
