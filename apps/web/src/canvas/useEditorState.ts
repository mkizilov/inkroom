import { useSyncExternalStore } from 'react';
import type { EditorState } from './editor';
import type { EditorSession } from './session';

// Subscribes a component to the session. The session replaces its state object on every change,
// so React re-renders only when something changed.
export function useEditorState(session: EditorSession): EditorState {
  return useSyncExternalStore(session.subscribe, session.getState);
}
