import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SharingPanel } from './SharingPanel';

const BOARD = '00000000-0000-4000-8000-0000000000b1';
const OWNER = '00000000-0000-4000-8000-000000000001';
const VIEWER = '00000000-0000-4000-8000-000000000002';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

// Serves the members list, and answers each request through `handle`, keyed by method and path.
function stubFetch(handle: (method: string, path: string, body: unknown) => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = new URL(String(input), 'http://localhost').pathname;
    return handle(init?.method ?? 'GET', path, body);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const members = (viewerRole = 'viewer') => ({
  items: [
    { userId: OWNER, displayName: 'Ada', role: 'owner', email: 'ada@example.com' },
    { userId: VIEWER, displayName: 'Grace', role: viewerRole, email: 'grace@example.com' },
  ],
});

function renderPanel(role: 'owner' | 'viewer', currentUserId: string) {
  return render(
    <MemoryRouter>
      <SharingPanel boardId={BOARD} role={role} currentUserId={currentUserId} />
    </MemoryRouter>,
  );
}

describe('SharingPanel', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('gives the owner the invite form, role controls and member emails', async () => {
    stubFetch(() => json(members()));
    renderPanel('owner', OWNER);

    expect(await screen.findByRole('list', { name: 'Members' })).toBeTruthy();
    expect(screen.getByRole('form', { name: 'Invite people' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Role for Grace' })).toBeTruthy();
    expect(screen.getByText('grace@example.com')).toBeTruthy();
  });

  it('gives a viewer the list without any control that changes access', async () => {
    stubFetch(() => json(members()));
    renderPanel('viewer', VIEWER);

    await screen.findByRole('list', { name: 'Members' });
    expect(screen.queryByRole('form', { name: 'Invite people' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Role for Grace' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove Grace' })).toBeNull();
    expect(screen.queryByText('grace@example.com')).toBeNull();
    expect(screen.getByRole('button', { name: 'Leave board' })).toBeTruthy();
  });

  it('refuses a malformed address before sending anything', async () => {
    const fetchMock = stubFetch(() => json(members()));
    renderPanel('owner', OWNER);
    await screen.findByRole('list', { name: 'Members' });

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'not-an-email' },
    });
    fireEvent.submit(screen.getByRole('form', { name: 'Invite people' }));

    expect(await screen.findByText('Enter a valid email address.')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('sends a role change to the server and shows the list it returns', async () => {
    let viewerRole = 'viewer';
    const fetchMock = stubFetch((method) => {
      if (method === 'PATCH') {
        viewerRole = 'editor';
        return json({ member: { userId: VIEWER, displayName: 'Grace', role: 'editor' } });
      }
      return json(members(viewerRole));
    });
    renderPanel('owner', OWNER);
    await screen.findByRole('list', { name: 'Members' });

    fireEvent.change(screen.getByRole('combobox', { name: 'Role for Grace' }), {
      target: { value: 'editor' },
    });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/boards/${BOARD}/members/${VIEWER}`,
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ role: 'editor' }) }),
      ),
    );
    await waitFor(() =>
      expect(
        (screen.getByRole('combobox', { name: 'Role for Grace' }) as HTMLSelectElement).value,
      ).toBe('editor'),
    );
  });

  it('shows the server’s refusal of an invitation, and keeps the list', async () => {
    stubFetch((method) =>
      method === 'POST'
        ? json(
            {
              error: {
                code: 'already_member',
                message: 'That user already has access to this board.',
              },
            },
            409,
          )
        : json(members()),
    );
    renderPanel('owner', OWNER);
    await screen.findByRole('list', { name: 'Members' });

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'grace@example.com' },
    });
    fireEvent.submit(screen.getByRole('form', { name: 'Invite people' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'That user already has access to this board.',
    );
    expect(screen.getByRole('list', { name: 'Members' })).toBeTruthy();
  });
});
