import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

const board = (overrides: Partial<Record<string, string>> = {}) => ({
  id: '00000000-0000-4000-8000-0000000000b1',
  title: 'Roadmap',
  ownerId: user.id,
  role: 'owner',
  createdAt: '2026-01-02T09:30:00.000Z',
  updatedAt: '2026-01-03T10:45:00.000Z',
  ...overrides,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const apiError = (code: string, message: string, status: number) =>
  json({ error: { code, message } }, status);

const unauthenticated = () =>
  json({ error: { code: 'unauthenticated', message: 'Sign in to continue.' } }, 401);

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

// Mocks fetch per "METHOD /path" (query string ignored). Unmocked requests fail the test.
function mockApi(handlers: Record<string, Handler>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    const handler = handlers[key];
    if (!handler) {
      throw new Error(`Unexpected request: ${key}`);
    }
    return handler(url, init);
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

const signedIn = (boardsHandler: Handler = () => json({ items: [], nextCursor: null })) => ({
  'GET /api/auth/me': () => json({ user }),
  'GET /api/health': () => json(healthBody),
  'GET /api/boards': boardsHandler,
});

describe('InkRoom web app', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  describe('authentication', () => {
    it('sends anonymous visitors from the dashboard to the sign-in page', async () => {
      mockApi({ 'GET /api/auth/me': unauthenticated });

      renderAt('/');

      expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    });

    it('shows field errors without sending the login form when input is invalid', async () => {
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
          apiError('invalid_credentials', 'Email or password is incorrect.', 401),
      });
      renderAt('/login');
      await screen.findByRole('heading', { name: 'Sign in' });

      fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } });
      fireEvent.change(screen.getByLabelText('Password'), {
        target: { value: 'wrong horse battery' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

      expect((await screen.findByRole('alert')).textContent).toBe(
        'Email or password is incorrect.',
      );
    });

    it('shows a loading state while signing in, then the dashboard', async () => {
      let finishLogin: (response: Response) => void = () => {};
      mockApi({
        'GET /api/auth/me': unauthenticated,
        'POST /api/auth/login': () =>
          new Promise<Response>((resolve) => {
            finishLogin = resolve;
          }),
        ...signedIn(),
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
      expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/auth/register')).toBe(
        false,
      );
    });
  });

  describe('dashboard', () => {
    it('shows the empty state when there are no boards', async () => {
      mockApi(signedIn());

      renderAt('/');

      expect(await screen.findByText('You do not have any boards yet.')).toBeTruthy();
      expect(screen.getByText(/Signed in as/)).toBeTruthy();
    });

    it('lists boards with dates and only the actions the role allows', async () => {
      const shared = board({
        id: '00000000-0000-4000-8000-0000000000b2',
        title: 'Shared',
        role: 'viewer',
      });
      mockApi(signedIn(() => json({ items: [board(), shared], nextCursor: null })));

      renderAt('/');

      const rows = await screen.findAllByRole('listitem');
      expect(rows).toHaveLength(2);

      const roadmap = within(rows[0] as HTMLElement);
      expect(roadmap.getByText('Owner')).toBeTruthy();
      expect(roadmap.getByRole('button', { name: 'Rename' })).toBeTruthy();
      expect(roadmap.getByRole('button', { name: 'Delete' })).toBeTruthy();
      expect(roadmap.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe(
        '/boards/00000000-0000-4000-8000-0000000000b1',
      );
      const created = roadmap.getByText(/Created/).querySelector('time');
      expect(created?.getAttribute('dateTime')).toBe('2026-01-02T09:30:00.000Z');
      expect(roadmap.getByText(/Modified/).querySelector('time')?.getAttribute('dateTime')).toBe(
        '2026-01-03T10:45:00.000Z',
      );

      const viewerRow = within(rows[1] as HTMLElement);
      expect(viewerRow.getByText('Viewer')).toBeTruthy();
      expect(viewerRow.queryByRole('button', { name: 'Rename' })).toBeNull();
      expect(viewerRow.queryByRole('button', { name: 'Delete' })).toBeNull();
    });

    it('shows an error state with a retry that loads the boards', async () => {
      let attempts = 0;
      mockApi(
        signedIn(() => {
          attempts += 1;
          return attempts === 1
            ? apiError('internal_error', 'Something went wrong. Try again.', 500)
            : json({ items: [board()], nextCursor: null });
        }),
      );

      renderAt('/');

      expect(await screen.findByText('Could not load your boards.')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

      expect(await screen.findByText('Roadmap')).toBeTruthy();
    });

    it('creates a board at the top of the list and rejects a blank name locally', async () => {
      const created = board({ id: '00000000-0000-4000-8000-0000000000c1', title: 'Brainstorm' });
      const fetchMock = mockApi({
        ...signedIn(() => json({ items: [board()], nextCursor: null })),
        'POST /api/boards': (_url, init) => {
          const body = JSON.parse(String(init?.body)) as { title: string };
          return json({ board: { ...created, title: body.title } }, 201);
        },
      });
      renderAt('/');
      await screen.findByText('Roadmap');

      fireEvent.click(screen.getByRole('button', { name: 'Create board' }));
      expect(await screen.findByText('Enter a board name.')).toBeTruthy();
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);

      fireEvent.change(screen.getByLabelText('New board name'), {
        target: { value: '  Brainstorm  ' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Create board' }));

      const titles = await screen.findAllByRole('listitem');
      expect(titles[0]?.textContent).toContain('Brainstorm');
      expect(titles[1]?.textContent).toContain('Roadmap');
    });

    it('renames a board inline and cancels without saving on request', async () => {
      const fetchMock = mockApi({
        ...signedIn(() => json({ items: [board()], nextCursor: null })),
        'PATCH /api/boards/00000000-0000-4000-8000-0000000000b1': (_url, init) => {
          const body = JSON.parse(String(init?.body)) as { title: string };
          return json({ board: board({ title: body.title }) });
        },
      });
      renderAt('/');
      await screen.findByText('Roadmap');

      fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
      fireEvent.change(screen.getByLabelText('Board name'), { target: { value: 'Q3 plan' } });
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.getByText('Roadmap')).toBeTruthy();
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
      fireEvent.change(screen.getByLabelText('Board name'), { target: { value: 'Q3 plan' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByText('Q3 plan')).toBeTruthy();
    });

    it('deletes a board only after confirmation and shows errors next to the row', async () => {
      let deleteStatus = 404;
      mockApi({
        ...signedIn(() => json({ items: [board()], nextCursor: null })),
        'DELETE /api/boards/00000000-0000-4000-8000-0000000000b1': () =>
          deleteStatus === 204
            ? new Response(null, { status: 204 })
            : apiError('board_not_found', 'Board not found.', 404),
      });
      renderAt('/');
      await screen.findByText('Roadmap');

      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.getByText('Roadmap')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
      fireEvent.click(screen.getByRole('button', { name: 'Delete board' }));

      expect(
        await screen.findByText('This board does not exist or you do not have access to it.'),
      ).toBeTruthy();
      expect(screen.getByText('Roadmap')).toBeTruthy();

      deleteStatus = 204;
      fireEvent.click(screen.getByRole('button', { name: 'Delete board' }));

      expect(await screen.findByText('You do not have any boards yet.')).toBeTruthy();
    });

    it('loads the next page when the list has more boards', async () => {
      mockApi(
        signedIn((url) =>
          url.searchParams.get('cursor')
            ? json({
                items: [
                  board({ id: '00000000-0000-4000-8000-0000000000b2', title: 'Second page' }),
                ],
                nextCursor: null,
              })
            : json({ items: [board()], nextCursor: 'opaque-cursor' }),
        ),
      );
      renderAt('/');
      await screen.findByText('Roadmap');

      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

      expect(await screen.findByText('Second page')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    });

    it('opens a board into the empty workspace with its title and role', async () => {
      mockApi({
        ...signedIn(() => json({ items: [board()], nextCursor: null })),
        'GET /api/boards/00000000-0000-4000-8000-0000000000b1': () => json({ board: board() }),
      });
      renderAt('/');
      await screen.findByText('Roadmap');

      fireEvent.click(screen.getByRole('link', { name: 'Open' }));

      expect(await screen.findByRole('heading', { name: 'Roadmap' })).toBeTruthy();
      expect(screen.getByText('Your role: Owner')).toBeTruthy();
      expect(screen.getByLabelText('Workspace').textContent).toContain('This workspace is empty');
    });
  });
});
