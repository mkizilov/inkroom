import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { Point, TextObject } from '@inkroom/shared';
import { CanvasScene } from './CanvasScene';
import { createEditorState, editorReducer, TOOL_SHORTCUTS, type EditorAction } from './editor';
import { describeCanvas } from './status';
import { Toolbar } from './Toolbar';
import { selectionBounds } from './transform';
import {
  INITIAL_VIEWPORT,
  pinchSample,
  pinchViewport,
  worldToScreen,
  type PinchSample,
  type PinchStart,
} from './viewport';

const ZOOM_STEP = 1.25;
// Wheel deltas in lines (Firefox) and pages are converted to approximate pixels.
const LINE_HEIGHT_PX = 16;
// Arrow keys nudge the selection by one world unit, or ten with Shift.
const NUDGE_STEP = 1;
const LARGE_NUDGE_STEP = 10;

const ARROW_DIRECTIONS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

const newId = () => crypto.randomUUID();

function pointIn(element: HTMLElement, clientX: number, clientY: number): Point {
  const rect = element.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
  );
}

// Ctrl or Cmd commands. Layout-independent key codes are used so shortcuts work on any keyboard.
function commandFor(event: KeyboardEvent): EditorAction | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) {
    return null;
  }
  switch (event.code) {
    case 'KeyZ':
      return event.shiftKey ? { type: 'redo' } : { type: 'undo' };
    case 'KeyY':
      return { type: 'redo' };
    case 'KeyA':
      return { type: 'selectAll' };
    case 'KeyC':
      return { type: 'copy' };
    case 'KeyX':
      return { type: 'cut' };
    case 'KeyV':
      return { type: 'paste', makeId: newId };
    case 'KeyD':
      return { type: 'duplicate', makeId: newId };
    case 'BracketRight':
      return { type: 'reorder', direction: event.shiftKey ? 'front' : 'forward' };
    case 'BracketLeft':
      return { type: 'reorder', direction: event.shiftKey ? 'back' : 'backward' };
    default:
      return null;
  }
}

function pinchFrom(points: Point[]): PinchSample | null {
  const [first, second] = points;
  return first && second ? pinchSample(first, second) : null;
}

export function CanvasEditor() {
  const [state, dispatch] = useReducer(editorReducer, undefined, createEditorState);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const pinchRef = useRef<PinchStart | null>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });

  useEffect(() => {
    const element = surfaceRef.current;
    if (!element) {
      return;
    }
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // React attaches wheel listeners as passive, and preventDefault must run to stop the page
  // from scrolling or zooming, so this listener is added directly.
  useEffect(() => {
    const element = surfaceRef.current;
    if (!element) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit =
        event.deltaMode === 1 ? LINE_HEIGHT_PX : event.deltaMode === 2 ? window.innerHeight : 1;
      dispatch({
        type: 'wheel',
        anchor: pointIn(element, event.clientX, event.clientY),
        input: {
          deltaX: event.deltaX * unit,
          deltaY: event.deltaY * unit,
          zoom: event.ctrlKey || event.metaKey,
        },
      });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) {
        return;
      }
      if (event.code === 'Space') {
        event.preventDefault();
        dispatch({ type: 'setSpaceHeld', held: true });
        return;
      }

      const command = commandFor(event);
      if (command) {
        event.preventDefault();
        dispatch(command);
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }

      const direction = ARROW_DIRECTIONS[event.key];
      if (direction) {
        event.preventDefault();
        const step = event.shiftKey ? LARGE_NUDGE_STEP : NUDGE_STEP;
        dispatch({ type: 'nudge', dx: direction[0] * step, dy: direction[1] * step });
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        dispatch({ type: 'deleteSelected' });
        return;
      }
      if (event.key === 'Escape') {
        dispatch({ type: 'clearSelection' });
        return;
      }
      const tool = TOOL_SHORTCUTS[event.key.toLowerCase()];
      if (tool) {
        dispatch({ type: 'setTool', tool });
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        dispatch({ type: 'setSpaceHeld', held: false });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // Pointer handling tracks every active pointer so two fingers can pinch and pan. The reducer
  // only ever sees a single pointer's gesture, plus viewport updates from pinching.
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const screen = pointIn(element, event.clientX, event.clientY);
    const pointers = pointersRef.current;
    pointers.set(event.pointerId, screen);
    element.setPointerCapture(event.pointerId);

    if (pointers.size === 2) {
      dispatch({ type: 'pointerCancel' });
      const sample = pinchFrom([...pointers.values()]);
      if (sample) {
        pinchRef.current = { ...sample, viewport: state.viewport };
      }
    } else if (pointers.size === 1) {
      dispatch({
        type: 'pointerDown',
        screen,
        button: event.button,
        shift: event.shiftKey,
        id: newId(),
      });
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointers = pointersRef.current;
    if (!pointers.has(event.pointerId)) {
      return;
    }
    const screen = pointIn(event.currentTarget, event.clientX, event.clientY);
    pointers.set(event.pointerId, screen);

    const pinch = pinchRef.current;
    if (pinch) {
      const sample = pinchFrom([...pointers.values()]);
      if (sample) {
        dispatch({ type: 'setViewport', viewport: pinchViewport(pinch, sample) });
      }
      return;
    }
    if (pointers.size === 1) {
      dispatch({ type: 'pointerMove', screen });
    }
  };

  const endPointer = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const pointers = pointersRef.current;
    if (!pointers.delete(event.pointerId)) {
      return;
    }
    const element = event.currentTarget;
    if (element.hasPointerCapture(event.pointerId)) {
      element.releasePointerCapture(event.pointerId);
    }
    if (pointers.size < 2) {
      pinchRef.current = null;
    }
    if (pointers.size === 0) {
      dispatch({ type: cancelled ? 'pointerCancel' : 'pointerUp' });
    }
  };

  const editingText = state.editingTextId
    ? state.objects.find(
        (object): object is TextObject =>
          object.type === 'text' && object.id === state.editingTextId,
      )
    : undefined;
  const editorPosition = editingText ? worldToScreen(editingText, state.viewport) : null;
  const center = { x: size.width / 2, y: size.height / 2 };
  const selectionBox = selectionBounds(state.objects, state.selectedIds);

  return (
    <div className="canvas-editor">
      <Toolbar
        tool={state.tool}
        scale={state.viewport.scale}
        status={describeCanvas(state.objects, state.selectedIds)}
        canEditSelection={state.selectedIds.length > 0}
        canUndo={state.history.past.length > 0}
        canRedo={state.history.future.length > 0}
        onToolChange={(tool) => dispatch({ type: 'setTool', tool })}
        onZoomIn={() => dispatch({ type: 'zoom', factor: ZOOM_STEP, anchor: center })}
        onZoomOut={() => dispatch({ type: 'zoom', factor: 1 / ZOOM_STEP, anchor: center })}
        onResetView={() => dispatch({ type: 'setViewport', viewport: INITIAL_VIEWPORT })}
        onUndo={() => dispatch({ type: 'undo' })}
        onRedo={() => dispatch({ type: 'redo' })}
        onDuplicate={() => dispatch({ type: 'duplicate', makeId: newId })}
        onBringForward={() => dispatch({ type: 'reorder', direction: 'forward' })}
        onSendBackward={() => dispatch({ type: 'reorder', direction: 'backward' })}
        onDelete={() => dispatch({ type: 'deleteSelected' })}
      />
      <div className="canvas-shell">
        <div
          ref={surfaceRef}
          className="canvas-surface"
          role="application"
          aria-label="Whiteboard canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(event) => endPointer(event, false)}
          onPointerCancel={(event) => endPointer(event, true)}
          onDoubleClick={(event) =>
            dispatch({
              type: 'doubleClick',
              screen: pointIn(event.currentTarget, event.clientX, event.clientY),
            })
          }
          onMouseDown={(event) => {
            // Stops the browser's middle-click autoscroll so the middle button can pan.
            if (event.button === 1) {
              event.preventDefault();
            }
          }}
        >
          <CanvasScene
            width={size.width}
            height={size.height}
            viewport={state.viewport}
            objects={state.objects}
            draft={state.draft}
            selectedIds={state.selectedIds}
            selectionBox={selectionBox}
            showHandles={state.tool === 'select'}
            marquee={state.marquee}
            hiddenTextId={state.editingTextId}
          />
        </div>
        {editingText && editorPosition && (
          <textarea
            className="text-overlay"
            aria-label="Text object"
            autoFocus
            value={editingText.text}
            onChange={(event) =>
              dispatch({ type: 'changeText', id: editingText.id, text: event.target.value })
            }
            onBlur={() => dispatch({ type: 'finishText' })}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                dispatch({ type: 'finishText' });
              }
            }}
            style={{
              left: editorPosition.x,
              top: editorPosition.y,
              fontSize: editingText.fontSize * state.viewport.scale,
              color: editingText.stroke,
            }}
          />
        )}
      </div>
    </div>
  );
}
