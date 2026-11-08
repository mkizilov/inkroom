import type { ConnectionState } from './sync/provider';
import type { Participant } from './presence/participants';
import type { Tool } from './editor';

const VIEWER_TOOLS: ReadonlyArray<Tool> = ['select', 'pan'];

const TOOL_BUTTONS: ReadonlyArray<{ tool: Tool; label: string; shortcut: string }> = [
  { tool: 'select', label: 'Select', shortcut: 'V' },
  { tool: 'pan', label: 'Hand', shortcut: 'H' },
  { tool: 'pen', label: 'Pen', shortcut: 'P' },
  { tool: 'rectangle', label: 'Rectangle', shortcut: 'R' },
  { tool: 'ellipse', label: 'Ellipse', shortcut: 'O' },
  { tool: 'line', label: 'Line', shortcut: 'L' },
  { tool: 'arrow', label: 'Arrow', shortcut: 'A' },
  { tool: 'text', label: 'Text', shortcut: 'T' },
];

// 'local' is an editor with no board behind it, so there is nothing to connect to.
export type ConnectionDisplay = 'local' | ConnectionState;

const CONNECTION_LABELS: Record<ConnectionDisplay, string> = {
  local: 'Local only',
  connecting: 'Connecting…',
  syncing: 'Syncing…',
  connected: 'Online',
  reconnecting: 'Reconnecting…',
  offline: 'Offline, retrying',
  stopped: 'Disconnected',
};

interface ToolbarProps {
  tool: Tool;
  scale: number;
  status: string;
  canEditSelection: boolean;
  canUndo: boolean;
  canRedo: boolean;
  participants: readonly Participant[];
  connection: ConnectionDisplay;
  readOnly: boolean;
  notice: string | null;
  onToolChange: (tool: Tool) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetView: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onDuplicate: () => void;
  onBringForward: () => void;
  onSendBackward: () => void;
  onDelete: () => void;
}

export function Toolbar({
  tool,
  scale,
  status,
  canEditSelection,
  canUndo,
  canRedo,
  participants,
  connection,
  readOnly,
  notice,
  onToolChange,
  onZoomIn,
  onZoomOut,
  onResetView,
  onUndo,
  onRedo,
  onDuplicate,
  onBringForward,
  onSendBackward,
  onDelete,
}: ToolbarProps) {
  return (
    <div className="toolbar-group">
      <div className="toolbar" role="toolbar" aria-label="Drawing tools">
        {TOOL_BUTTONS.map((button) => (
          <button
            key={button.tool}
            type="button"
            aria-pressed={tool === button.tool}
            title={`${button.label} (${button.shortcut})`}
            disabled={readOnly && !VIEWER_TOOLS.includes(button.tool)}
            onClick={() => onToolChange(button.tool)}
          >
            {button.label}
          </button>
        ))}
        <span className="toolbar-separator" aria-hidden="true" />
        <button type="button" onClick={onZoomOut} title="Zoom out (Ctrl + wheel)">
          Zoom out
        </button>
        <output aria-label="Zoom level">{Math.round(scale * 100)}%</output>
        <button type="button" onClick={onZoomIn} title="Zoom in (Ctrl + wheel)">
          Zoom in
        </button>
        <button type="button" onClick={onResetView}>
          Reset view
        </button>
      </div>
      <div className="toolbar" role="toolbar" aria-label="Editing">
        <button
          type="button"
          onClick={onUndo}
          disabled={readOnly || !canUndo}
          title="Undo (Ctrl + Z)"
        >
          Undo
        </button>
        <button
          type="button"
          onClick={onRedo}
          disabled={readOnly || !canRedo}
          title="Redo (Ctrl + Shift + Z)"
        >
          Redo
        </button>
        <span className="toolbar-separator" aria-hidden="true" />
        <button
          type="button"
          onClick={onDuplicate}
          disabled={readOnly || !canEditSelection}
          title="Duplicate (Ctrl + D)"
        >
          Duplicate
        </button>
        <button
          type="button"
          onClick={onBringForward}
          disabled={readOnly || !canEditSelection}
          title="Bring forward (Ctrl + ])"
        >
          Bring forward
        </button>
        <button
          type="button"
          onClick={onSendBackward}
          disabled={readOnly || !canEditSelection}
          title="Send backward (Ctrl + [)"
        >
          Send backward
        </button>
        <button type="button" onClick={onDelete} disabled={readOnly || !canEditSelection}>
          Delete selected
        </button>
        <p role="status" aria-label="Canvas status" className="canvas-status">
          {status}
        </p>
      </div>
      <div className="toolbar presence-bar">
        <output aria-label="Connection status" className={`connection connection-${connection}`}>
          {CONNECTION_LABELS[connection]}
        </output>
        {readOnly && <span className="view-only">View only</span>}
        <ul aria-label="Participants" className="participants">
          {participants.map((participant) => (
            <li key={participant.clientId} data-testid="participant" className="participant">
              <span
                className="participant-dot"
                style={{ background: participant.state.user.color }}
                aria-hidden="true"
              />
              {participant.state.user.name}
              {participant.isSelf ? ' (you)' : ''}
            </li>
          ))}
        </ul>
        <span className="participant-count">
          {participants.length} {participants.length === 1 ? 'participant' : 'participants'}
        </span>
        {notice && (
          <p role="alert" className="notice">
            {notice}
          </p>
        )}
      </div>
    </div>
  );
}
