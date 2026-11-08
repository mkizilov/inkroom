import type { CanvasObject } from '@inkroom/shared';
import { objectBounds } from '../geometry';
import type { Viewport } from '../viewport';
import { worldToScreen } from '../viewport';
import { placeCursor, screenBoxFor, type ScreenSize } from './overlay-geometry';
import type { Participant } from './participants';

interface PresenceOverlayProps {
  participants: readonly Participant[];
  objects: readonly CanvasObject[];
  viewport: Viewport;
  size: ScreenSize;
}

// Remote cursors and selections, drawn in this client's screen space over the canvas. The overlay
// ignores the pointer, so it never gets in the way of editing. Each remote participant is shown in
// its own colour, and a cursor outside the visible area is pinned to the nearest edge.
export function PresenceOverlay({ participants, objects, viewport, size }: PresenceOverlayProps) {
  const remote = participants.filter((participant) => !participant.isSelf);

  return (
    <div className="presence-overlay" aria-hidden="true">
      {remote.flatMap((participant) =>
        participant.state.selection.flatMap((id) => {
          const object = objects.find((candidate) => candidate.id === id);
          if (!object) {
            return [];
          }
          const box = screenBoxFor(objectBounds(object), viewport);
          return [
            <div
              key={`${participant.clientId}-${id}`}
              className="remote-selection"
              data-testid="remote-selection"
              style={{
                left: box.x,
                top: box.y,
                width: box.width,
                height: box.height,
                borderColor: participant.state.user.color,
              }}
            />,
          ];
        }),
      )}
      {remote.map((participant) => {
        const cursor = participant.state.cursor;
        if (!cursor) {
          return null;
        }
        const placed = placeCursor(worldToScreen(cursor, viewport), size);
        return (
          <div
            key={participant.clientId}
            className="remote-cursor"
            data-testid="remote-cursor"
            data-offscreen={placed.onScreen ? undefined : 'true'}
            style={{ left: placed.x, top: placed.y, color: participant.state.user.color }}
          >
            <span className="remote-cursor-dot" />
            <span className="remote-cursor-label">{participant.state.user.name}</span>
          </div>
        );
      })}
    </div>
  );
}
