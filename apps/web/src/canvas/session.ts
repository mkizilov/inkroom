import { CanvasDocument, LOCAL_ORIGIN } from './doc/canvas-document';
import {
  createEditorState,
  editorReducer,
  type EditorAction,
  type EditorState,
  type Tool,
  type UndoState,
} from './editor';

// A read-only session (a viewer's) accepts only these actions. None of them can write to the
// document, so a viewer cannot change the board even by calling dispatch directly.
const READ_ONLY_ACTIONS: ReadonlySet<EditorAction['type']> = new Set<EditorAction['type']>([
  'wheel',
  'zoom',
  'setViewport',
  'setSpaceHeld',
  'pointerMove',
  'pointerUp',
  'pointerCancel',
]);
// Drawing tools would only produce refused edits, so a read-only session may not select them.
const READ_ONLY_TOOLS: ReadonlySet<Tool> = new Set<Tool>(['select', 'pan']);

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
  private readOnly = false;

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
    if (this.readOnly && !this.allowedWhileReadOnly(action)) {
      return;
    }
    this.state = editorReducer(this.state, action);
    this.flush();
    this.emit();
  };

  // Switches the session between editing and viewing. Turning read-only first ends any drag in
  // progress and leaves a drawing tool, so no gesture is left that could finish as an edit.
  setReadOnly(readOnly: boolean): void {
    if (readOnly) {
      this.dispatch({ type: 'pointerCancel' });
      if (!READ_ONLY_TOOLS.has(this.state.tool)) {
        this.dispatch({ type: 'setTool', tool: 'select' });
      }
    }
    this.readOnly = readOnly;
  }

  private allowedWhileReadOnly(action: EditorAction): boolean {
    switch (action.type) {
      case 'pointerDown':
        // The reducer starts a pan under this same test, so only a pan can begin while read-only.
        return action.button === 1 || this.state.spaceHeld || this.state.tool === 'pan';
      case 'setTool':
        return READ_ONLY_TOOLS.has(action.tool);
      default:
        return READ_ONLY_ACTIONS.has(action.type);
    }
  }

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
