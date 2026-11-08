import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CanvasEditor } from './CanvasEditor';
import { CanvasScene } from './CanvasScene';

// The scene draws with Konva, which needs a real 2D canvas that jsdom does not provide. The mock
// records its props so tests can check the document the editor produced.
vi.mock('./CanvasScene', () => ({ CanvasScene: vi.fn(() => null) }));

// jsdom has no pointer capture or layout. Positions are taken as client coordinates, which is
// what getBoundingClientRect returns (zeros) in jsdom.
beforeAll(() => {
  Object.assign(Element.prototype, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
  });
});

function sendPointer(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  x: number,
  y: number,
) {
  act(() => {
    target.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }),
    );
  });
}

function sendWheel(target: Element, deltaY: number, ctrlKey: boolean) {
  act(() => {
    target.dispatchEvent(
      new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, ctrlKey }),
    );
  });
}

function lastSceneProps() {
  const props = vi.mocked(CanvasScene).mock.lastCall?.[0];
  if (!props) {
    throw new Error('the scene was not rendered');
  }
  return props;
}

describe('CanvasEditor controls', () => {
  afterEach(() => {
    cleanup();
  });

  it('starts with the select tool and nothing to delete', () => {
    render(<CanvasEditor />);

    expect(screen.getByRole('button', { name: 'Select' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'Rectangle' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect((screen.getByRole('button', { name: 'Delete selected' }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it('switches tools from the toolbar', () => {
    render(<CanvasEditor />);

    fireEvent.click(screen.getByRole('button', { name: 'Rectangle' }));

    expect(screen.getByRole('button', { name: 'Rectangle' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'Select' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('switches tools with keyboard shortcuts', () => {
    render(<CanvasEditor />);

    fireEvent.keyDown(window, { key: 'p' });

    expect(screen.getByRole('button', { name: 'Pen' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('zooms in and out in steps and resets the view', () => {
    render(<CanvasEditor />);
    const readout = screen.getByLabelText('Zoom level');

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(readout.textContent).toBe('125%');

    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(readout.textContent).toBe('80%');

    fireEvent.click(screen.getByRole('button', { name: 'Reset view' }));
    expect(readout.textContent).toBe('100%');
  });

  it('exposes the drawing surface as an application region', () => {
    render(<CanvasEditor />);

    expect(screen.getByRole('application', { name: 'Whiteboard canvas' })).toBeTruthy();
  });
});

describe('CanvasEditor pointer and wheel input', () => {
  afterEach(() => {
    cleanup();
  });

  it('draws a rectangle from a pointer drag into the document', () => {
    render(<CanvasEditor />);
    const surface = screen.getByRole('application', { name: 'Whiteboard canvas' });
    fireEvent.click(screen.getByRole('button', { name: 'Rectangle' }));

    sendPointer(surface, 'pointerdown', 100, 100);
    sendPointer(surface, 'pointermove', 160, 140);
    sendPointer(surface, 'pointerup', 160, 140);

    expect(lastSceneProps().objects).toEqual([
      expect.objectContaining({ type: 'rectangle', x: 100, y: 100, width: 60, height: 40 }),
    ]);
  });

  it('zooms with Ctrl + wheel, and back-to-back events accumulate', () => {
    render(<CanvasEditor />);
    const surface = screen.getByRole('application', { name: 'Whiteboard canvas' });

    sendWheel(surface, -100, true);
    sendWheel(surface, -100, true);

    expect(screen.getByLabelText('Zoom level').textContent).toBe(
      `${Math.round(Math.exp(2) * 100)}%`,
    );
  });

  it('draws at the world position under the pointer after zooming', () => {
    render(<CanvasEditor />);
    const surface = screen.getByRole('application', { name: 'Whiteboard canvas' });
    sendWheel(surface, -100, true);
    sendWheel(surface, -100, true);
    fireEvent.click(screen.getByRole('button', { name: 'Rectangle' }));

    // The zoom anchor is the origin, so world (100, 50) is at screen (100 * scale, 50 * scale).
    const scale = Math.exp(2);
    sendPointer(surface, 'pointerdown', 100 * scale, 50 * scale);
    sendPointer(surface, 'pointermove', 150 * scale, 90 * scale);
    sendPointer(surface, 'pointerup', 150 * scale, 90 * scale);

    expect(lastSceneProps().objects).toEqual([
      expect.objectContaining({
        type: 'rectangle',
        x: expect.closeTo(100, 6),
        y: expect.closeTo(50, 6),
        width: expect.closeTo(50, 6),
        height: expect.closeTo(40, 6),
      }),
    ]);
  });

  it('pans with a plain wheel without changing the zoom', () => {
    render(<CanvasEditor />);
    const surface = screen.getByRole('application', { name: 'Whiteboard canvas' });

    sendWheel(surface, 40, false);

    expect(screen.getByLabelText('Zoom level').textContent).toBe('100%');
    expect(lastSceneProps().viewport).toEqual({ scale: 1, offsetX: 0, offsetY: -40 });
  });
});
