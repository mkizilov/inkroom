import type { Tool } from './editor';

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

interface ToolbarProps {
  tool: Tool;
  scale: number;
  status: string;
  canEditSelection: boolean;
  canUndo: boolean;
  canRedo: boolean;
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
        <button type="button" onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl + Z)">
          Undo
        </button>
        <button
          type="button"
          onClick={onRedo}
          disabled={!canRedo}
          title="Redo (Ctrl + Shift + Z)"
        >
          Redo
        </button>
        <span className="toolbar-separator" aria-hidden="true" />
        <button
          type="button"
          onClick={onDuplicate}
          disabled={!canEditSelection}
          title="Duplicate (Ctrl + D)"
        >
          Duplicate
        </button>
        <button
          type="button"
          onClick={onBringForward}
          disabled={!canEditSelection}
          title="Bring forward (Ctrl + ])"
        >
          Bring forward
        </button>
        <button
          type="button"
          onClick={onSendBackward}
          disabled={!canEditSelection}
          title="Send backward (Ctrl + [)"
        >
          Send backward
        </button>
        <button type="button" onClick={onDelete} disabled={!canEditSelection}>
          Delete selected
        </button>
        <p role="status" aria-label="Canvas status" className="canvas-status">
          {status}
        </p>
      </div>
    </div>
  );
}
