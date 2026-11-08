// @vitest-environment node
// Benchmarks of the document layer: Yjs transactions, snapshots and editor actions on a board of
// 1,000 objects. They need the installed dependencies (yjs and zod), so run them with
// `pnpm --filter @inkroom/web bench`. See docs/performance.md for what they measure.

import type { CanvasObject } from '@inkroom/shared';
import { bench, describe } from 'vitest';
import { CanvasDocument } from '../src/canvas/doc/canvas-document';
import { EditorSession } from '../src/canvas/session';
import { generateBoard } from './fixtures';

const board = generateBoard(1_000);

// A filled rectangle on top of the board, so a press inside it always picks it.
const dragTarget: CanvasObject = {
  id: '00000000-0000-4000-8000-0000000003e8',
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  stroke: '#000000',
  strokeWidth: 2,
  fill: '#ffffff',
};

const press = {
  type: 'pointerDown' as const,
  screen: { x: 50, y: 50 },
  button: 0,
  shift: false,
  id: 'drag',
};

function documentWith(objects: readonly CanvasObject[]): CanvasDocument {
  const document = new CanvasDocument();
  document.apply([{ type: 'insert', index: 0, objects: [...objects] }], { boundary: true });
  return document;
}

// Runs one drag of `moves` pointer moves and returns how many Yjs updates it produced. Each update
// becomes one frame to the server.
function dragUpdates(moves: number): number {
  const document = documentWith([...board, dragTarget]);
  const session = new EditorSession(document);
  let updates = 0;
  document.doc.on('update', () => {
    updates += 1;
  });
  session.dispatch(press);
  for (let step = 1; step <= moves; step += 1) {
    session.dispatch({ type: 'pointerMove', screen: { x: 50 + step, y: 50 } });
  }
  session.dispatch({ type: 'pointerUp' });
  return updates;
}

console.log(`Yjs updates for a 60-move drag of one object: ${dragUpdates(60)}`);

describe('document, 1,000 objects', () => {
  const loaded = documentWith(board);

  bench('write the whole board in one transaction', () => {
    documentWith(board);
  });

  bench('snapshot the board in z-order', () => {
    loaded.snapshot();
  });

  bench('encode the board state', () => {
    loaded.encodeState();
  });

  bench('one local edit (move one object)', () => {
    loaded.apply([{ type: 'update', id: board[500]?.id ?? '', changes: { x: 5 } }], {
      boundary: true,
    });
  });
});

// The editor benchmarks include building the 1,000-object document in each iteration, so they are
// upper bounds for the editor work alone.
describe('editor actions, 1,000 objects (includes building the document)', () => {
  bench('select all, then ten nudges', () => {
    const session = new EditorSession(documentWith(board));
    session.dispatch({ type: 'selectAll' });
    for (let step = 0; step < 10; step += 1) {
      session.dispatch({ type: 'nudge', dx: 1, dy: 0 });
    }
  });

  bench('drag one object through 60 pointer moves', () => {
    const session = new EditorSession(documentWith([...board, dragTarget]));
    session.dispatch(press);
    for (let step = 1; step <= 60; step += 1) {
      session.dispatch({ type: 'pointerMove', screen: { x: 50 + step, y: 50 } });
    }
    session.dispatch({ type: 'pointerUp' });
  });
});
