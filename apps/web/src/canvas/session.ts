import { CanvasDocument, LOCAL_ORIGIN } from './doc/canvas-document';
import {
  createEditorState,
  editorReducer,
  type EditorAction,
  type EditorState,
  type UndoState,
} from './editor';

// Connects the editor reducer to the collaborative document.
//
// Data flow:
//   user action -> reducer -> view (state.objects) + outbox
//   outbox -> document (Yjs transaction per write; undo and redo as document operations)
//   document change from elsewhere (remote, undo, redo) -> reducer (syncObjects) -> view
//
// Changes that this session wrote are already in the view, so the document's notification for
// them (origin LOCAL_ORIGIN) is ignored. That keeps the loop from echoing edits back.
export class EditorSession {
  readonly document: CanvasDocument;
  private state: EditorState;
  private readonly listeners = new Set<() => void>();

  constructor(document: CanvasDocument = new CanvasDocument()) {
    this.document = document;
    this.state = {
      ...createEditorState(),
      objects: document.snapshot(),
      undoState: readUndoState(document),
    };
    document.subscribe((change) => {
      if (change.origin !== LOCAL_ORIGIN) {
        this.adoptDocument();
      }
    });
  }

  getState = (): EditorState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  dispatch = (action: EditorAction): void => {
    this.state = editorReducer(this.state, action);
    this.flush();
    this.emit();
  };

  // Applies queued writes in order. Each write is one document transaction, and undo or redo is
  // forwarded to the document's undo manager.
  private flush(): void {
    const entries = this.state.outbox;
    if (entries.length === 0) {
      this.refreshUndoState();
      return;
    }
    this.state = { ...this.state, outbox: [] };
    for (const entry of entries) {
      switch (entry.kind) {
        case 'write':
          this.document.apply(entry.operations, { boundary: entry.boundary });
          break;
        case 'undo':
          this.document.undo();
          break;
        case 'redo':
          this.document.redo();
          break;
      }
    }
    this.refreshUndoState();
  }

  private adoptDocument(): void {
    this.state = editorReducer(this.state, {
      type: 'syncObjects',
      objects: this.document.snapshot(),
    });
    this.refreshUndoState();
    this.emit();
  }

  private refreshUndoState(): void {
    this.state = { ...this.state, undoState: readUndoState(this.document) };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function readUndoState(document: CanvasDocument): UndoState {
  return { canUndo: document.canUndo(), canRedo: document.canRedo() };
}
