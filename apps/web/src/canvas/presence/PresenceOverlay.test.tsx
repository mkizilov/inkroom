import { cleanup, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness, type CanvasObject } from '@inkroom/shared';
import { PresenceOverlay } from './PresenceOverlay';
import { participantsOf, type Participant } from './participants';

const OBJECT_ID = '00000000-0000-4000-8000-0000000000c1';
const object: CanvasObject = {
  id: OBJECT_ID,
  type: 'rectangle',
  x: 100,
  y: 100,
  width: 50,
  height: 40,
  stroke: '#000000',
  strokeWidth: 2,
};

// Builds the participant list a client would see: itself, and one remote participant.
interface RemoteState {
  cursor: { x: number; y: number } | null;
  selection: string[];
}

function participantsWith(state: RemoteState): Participant[] {
  const me = new Awareness();
  me.setLocalState({
    user: { id: '00000000-0000-4000-8000-0000000000aa', name: 'Ada', color: '#1971c2' },
    cursor: null,
    selection: [],
  });
  const other = new Awareness();
  other.setLocalState({
    user: { id: '00000000-0000-4000-8000-0000000000bb', name: 'Bob', color: '#e03131' },
    ...state,
  });
  me.applyUpdate(other.encodeLocal());
  return participantsOf(me);
}

describe('PresenceOverlay', () => {
  afterEach(() => {
    cleanup();
  });

  it('draws a remote cursor with the participant name, at its position in this view', () => {
    const { getByTestId, queryByTestId } = render(
      <PresenceOverlay
        participants={participantsWith({ cursor: { x: 10, y: 20 }, selection: [] })}
        objects={[]}
        viewport={{ scale: 2, offsetX: 100, offsetY: 50 }}
        size={{ width: 800, height: 600 }}
      />,
    );

    const cursor = getByTestId('remote-cursor');
    expect(within(cursor).getByText('Bob')).toBeTruthy();
    expect(cursor.style.left).toBe('120px');
    expect(cursor.style.top).toBe('90px');
    expect(cursor.getAttribute('data-offscreen')).toBeNull();
    expect(queryByTestId('remote-cursor')).not.toBeNull();
  });

  it('pins a cursor that is outside this view to the edge and marks it', () => {
    const { getByTestId } = render(
      <PresenceOverlay
        participants={participantsWith({ cursor: { x: 5000, y: 20 }, selection: [] })}
        objects={[]}
        viewport={{ scale: 1, offsetX: 0, offsetY: 0 }}
        size={{ width: 800, height: 600 }}
      />,
    );

    expect(getByTestId('remote-cursor').getAttribute('data-offscreen')).toBe('true');
    expect(getByTestId('remote-cursor').style.left).toBe('784px');
  });

  it('outlines a remote selection through the local zoom and pan', () => {
    const { getByTestId } = render(
      <PresenceOverlay
        participants={participantsWith({ cursor: null, selection: [OBJECT_ID] })}
        objects={[object]}
        viewport={{ scale: 2, offsetX: 10, offsetY: 0 }}
        size={{ width: 800, height: 600 }}
      />,
    );

    const box = getByTestId('remote-selection');
    expect(box.style.left).toBe('210px');
    expect(box.style.width).toBe('100px');
  });

  it('draws nothing for the local participant and for selections it cannot find', () => {
    const { queryByTestId } = render(
      <PresenceOverlay
        participants={participantsWith({
          cursor: null,
          selection: ['00000000-0000-4000-8000-00000000ffff'],
        })}
        objects={[object]}
        viewport={{ scale: 1, offsetX: 0, offsetY: 0 }}
        size={{ width: 800, height: 600 }}
      />,
    );

    expect(queryByTestId('remote-selection')).toBeNull();
    expect(queryByTestId('remote-cursor')).toBeNull();
  });
});
