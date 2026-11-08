import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanvasEditor } from './CanvasEditor';

// The scene draws with Konva, which needs a real 2D canvas that jsdom does not provide.
vi.mock('./CanvasScene', () => ({ CanvasScene: () => null }));

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
