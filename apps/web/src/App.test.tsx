import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const healthBody = {
  status: 'ok',
  service: 'inkroom-api',
  database: 'up',
  timestamp: '2026-01-01T00:00:00.000Z',
};

describe('App', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the API health status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(healthBody), { status: 200 })),
    );

    render(<App />);

    expect(await screen.findByText(/API status: ok \(database: up\)/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'InkRoom' })).toBeTruthy();
  });

  it('reports when the API cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    render(<App />);

    expect(await screen.findByText(/API unreachable: Failed to fetch/)).toBeTruthy();
  });
});
