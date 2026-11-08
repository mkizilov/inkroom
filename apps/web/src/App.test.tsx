import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from './auth/AuthContext';
import { AppRoutes } from './App';

const user = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'ada@example.com',
  displayName: 'Ada',
};

const healthBody = {
  status: 'ok',
  service: 'inkroom-api',
  database: 'up',
  timestamp: '2026-01-01T00:00:00.000Z',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const unauthenticated = () =>
  json({ error: { code: 'unauthenticated', message: 'Sign in to continue.' } }, 401);

// Mocks fetch per "METHOD /path" pair. Any request without a handler fails the test.
function mockApi(handlers: Record<string, () => Response | Promise<Response>>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    const handler = handlers[key];
    if (!handler) {
      throw new Error(`Unexpected request: ${key}`);
    }
    return handler();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('InkRoom web app', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('sends anonymous visitors from the home page to the sign-in page', async () => {
    mockApi({ 'GET /api/auth/me': unauthenticated });

    renderAt('/');

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
  });

  it('shows field errors without sending the form when input is invalid', async () => {
    const fetchMock = mockApi({ 'GET /api/auth/me': unauthenticated });
    renderAt('/login');
    await screen.findByRole('heading', { name: 'Sign in' });

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Enter a valid email address.')).toBeTruthy();
    expect(screen.getByText('Enter your password.')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/auth/login')).toBe(false);
  });

  it('explains invalid credentials in an alert', async () => {
    mockApi({
      'GET /api/auth/me': unauthenticated,
      'POST /api/auth/login': () =>
        json(
          { error: { code: 'invalid_credentials', message: 'Email or password is incorrect.' } },
          401,
        ),
    });
    renderAt('/login');
    await screen.findByRole('heading', { name: 'Sign in' });

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'wrong horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Email or password is incorrect.',
    );
  });

  it('shows a loading state while signing in and then shows the home page', async () => {
    let finishLogin: (response: Response) => void = () => {};
    mockApi({
      'GET /api/auth/me': unauthenticated,
      'POST /api/auth/login': () =>
        new Promise<Response>((resolve) => {
          finishLogin = resolve;
        }),
      'GET /api/health': () => json(healthBody),
    });
    renderAt('/login');
    await screen.findByRole('heading', { name: 'Sign in' });

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    const pending = await screen.findByRole('button', { name: 'Signing in…' });
    expect(pending).toHaveProperty('disabled', true);

    finishLogin(json({ user }));

    expect(await screen.findByText(/Signed in as/)).toBeTruthy();
    expect(await screen.findByText('API status: ok (database: up)')).toBeTruthy();
  });

  it('validates registration passwords before calling the API', async () => {
    const fetchMock = mockApi({ 'GET /api/auth/me': unauthenticated });
    renderAt('/register');
    await screen.findByRole('heading', { name: 'Create account' });

    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText(/Password/), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('Use at least 12 characters.')).toBeTruthy();
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/auth/register')).toBe(
        false,
      ),
    );
  });
});
