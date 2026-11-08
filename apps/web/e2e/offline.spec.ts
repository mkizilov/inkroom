import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type WebSocketRoute,
} from '@playwright/test';

// Offline editing against the real API. Going offline has two parts, both controlled here: the
// browser's network is cut (HTTP requests fail), and the board's WebSocket is refused or dropped.
// A refused WebSocket closes at once, which the page treats as a lost connection and retries.

const password = 'correct horse battery';

test.setTimeout(120_000);

// Lets a test drop and restore a page's board connection on demand.
class SocketControl {
  private online = true;
  private readonly routes: WebSocketRoute[] = [];

  async attach(page: Page): Promise<void> {
    await page.routeWebSocket(/\/api\/boards\/[^/]+\/sync$/, (route) => {
      if (this.online) {
        this.routes.push(route);
        route.connectToServer();
      } else {
        route.close({ code: 1000, reason: 'offline for the test' });
      }
    });
  }

  goOffline(): void {
    this.online = false;
    for (const route of this.routes.splice(0)) {
      route.close({ code: 1000, reason: 'offline for the test' });
    }
  }

  goOnline(): void {
    this.online = true;
  }
}

function status(page: Page): Locator {
  return page.getByRole('status', { name: 'Canvas status' });
}

function connection(page: Page): Locator {
  return page.getByRole('status', { name: 'Connection status' });
}

// The device copy is IndexedDB database `inkroom-offline`, store `updates`, with one row per saved
// change (apps/web/src/offline/indexeddb-store.ts).
async function deviceUpdateCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open('inkroom-offline', 1);
        request.onsuccess = () => {
          const database = request.result;
          const count = database.transaction('updates', 'readonly').objectStore('updates').count();
          count.onsuccess = () => {
            database.close();
            resolve(count.result);
          };
          count.onerror = () => reject(count.error);
        };
        request.onerror = () => reject(request.error);
      }),
  );
}

// Waits until the device copy stops changing, so a count read now includes every save so far.
async function settledDeviceUpdateCount(page: Page): Promise<number> {
  let previous = -1;
  await expect
    .poll(async () => {
      const current = await deviceUpdateCount(page);
      const settled = current === previous;
      previous = current;
      return settled;
    })
    .toBe(true);
  return previous;
}

function tool(page: Page, name: string): Locator {
  return page.getByRole('button', { name, exact: true });
}

async function canvasOrigin(page: Page): Promise<{ x: number; y: number }> {
  const surface = page.getByRole('application', { name: 'Whiteboard canvas' });
  // The sharing panel sits above the canvas, so on a short screen the canvas starts below the fold.
  await surface.scrollIntoViewIfNeeded();
  const box = await surface.boundingBox();
  if (!box) {
    throw new Error('the whiteboard canvas is not visible');
  }
  return { x: box.x, y: box.y };
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}

async function signInAsNewAccount(page: Page, email: string): Promise<void> {
  await page.goto('/register');
  await page.getByLabel('Display name').fill('Offline tester');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Your boards' })).toBeVisible();
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Your boards' })).toBeVisible();
}

async function openNewBoard(page: Page, title: string): Promise<string> {
  await page.getByLabel('New board name').fill(title);
  await page.getByRole('button', { name: 'Create board' }).click();
  await page
    .getByRole('listitem')
    .filter({ hasText: title })
    .getByRole('link', { name: 'Open' })
    .click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  return new URL(page.url()).pathname;
}

function newEmail(): string {
  return `offline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

test('an edit made offline survives a reload, and reaches the server when the connection returns', async ({
  browser,
}: {
  browser: Browser;
}) => {
  const email = newEmail();
  const context: BrowserContext = await browser.newContext();
  const page = await context.newPage();
  const socket = new SocketControl();
  await socket.attach(page);

  try {
    await signInAsNewAccount(page, email);
    // The first load under the service worker stores the app's files, so later loads work offline.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Your boards' })).toBeVisible();
    const boardPath = await openNewBoard(page, 'Offline board');
    await expect(connection(page)).toHaveText('Online', { timeout: 15_000 });

    await tool(page, 'Rectangle').click();
    const origin = await canvasOrigin(page);
    await drag(
      page,
      { x: origin.x + 200, y: origin.y + 200 },
      { x: origin.x + 300, y: origin.y + 260 },
    );
    await expect(status(page)).toContainText('1 object');
    const savedBeforeOfflineEdit = await settledDeviceUpdateCount(page);

    // Lose the network and the connection, then keep editing.
    socket.goOffline();
    await context.setOffline(true);
    await expect(connection(page)).toHaveText('Offline, retrying', { timeout: 15_000 });
    await tool(page, 'Rectangle').click();
    await drag(
      page,
      { x: origin.x + 400, y: origin.y + 200 },
      { x: origin.x + 500, y: origin.y + 260 },
    );
    await expect(status(page)).toContainText('2 objects');

    // The reload must not start while the offline edit is still being written to the device.
    await expect.poll(() => deviceUpdateCount(page)).toBeGreaterThan(savedBeforeOfflineEdit);

    // Reload while still offline: the app and the board open from this device, with both objects.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Offline board' })).toBeVisible();
    await expect(page.getByText('Opened from the copy saved on this device.')).toBeVisible();
    await expect(status(page)).toContainText('2 objects');

    // Back online: the offline object reaches the server, and a second browser sees it.
    socket.goOnline();
    await context.setOffline(false);
    await expect(connection(page)).toHaveText('Online', { timeout: 30_000 });

    const other = await browser.newContext();
    try {
      const second = await other.newPage();
      await signIn(second, email);
      await second.goto(boardPath);
      await expect(status(second)).toContainText('2 objects', { timeout: 15_000 });
    } finally {
      await other.close();
    }
  } finally {
    await context.close();
  }
});

test('two people who edit offline merge their changes on reconnect, with no duplicates', async ({
  browser,
}: {
  browser: Browser;
}) => {
  const email = newEmail();
  const first = await browser.newContext();
  const second = await browser.newContext();
  const a = await first.newPage();
  const b = await second.newPage();
  const socketA = new SocketControl();
  const socketB = new SocketControl();
  await socketA.attach(a);
  await socketB.attach(b);

  try {
    await signInAsNewAccount(a, email);
    const boardPath = await openNewBoard(a, 'Merge board');
    await expect(connection(a)).toHaveText('Online', { timeout: 15_000 });

    await signIn(b, email);
    await b.goto(boardPath);
    await expect(b.getByRole('heading', { name: 'Merge board' })).toBeVisible();
    await expect(connection(b)).toHaveText('Online', { timeout: 15_000 });

    // Both lose the connection and edit.
    socketA.goOffline();
    socketB.goOffline();
    await expect(connection(a)).toHaveText('Offline, retrying', { timeout: 15_000 });
    await expect(connection(b)).toHaveText('Offline, retrying', { timeout: 15_000 });

    const originA = await canvasOrigin(a);
    await tool(a, 'Rectangle').click();
    await drag(
      a,
      { x: originA.x + 200, y: originA.y + 200 },
      { x: originA.x + 300, y: originA.y + 260 },
    );
    const originB = await canvasOrigin(b);
    await tool(b, 'Rectangle').click();
    await drag(
      b,
      { x: originB.x + 400, y: originB.y + 200 },
      { x: originB.x + 500, y: originB.y + 260 },
    );
    await expect(status(a)).toContainText('1 object');
    await expect(status(b)).toContainText('1 object');

    // Both reconnect: each sees both objects, once each.
    socketA.goOnline();
    socketB.goOnline();
    await expect(status(a)).toContainText('2 objects', { timeout: 30_000 });
    await expect(status(b)).toContainText('2 objects', { timeout: 30_000 });
    await expect(connection(a)).toHaveText('Online', { timeout: 30_000 });
    await expect(connection(b)).toHaveText('Online', { timeout: 30_000 });
    expect(await status(a).textContent()).not.toMatch(/\b[3-9] objects/);
    expect(await status(b).textContent()).not.toMatch(/\b[3-9] objects/);
  } finally {
    await first.close();
    await second.close();
  }
});

test('a board deleted while it is open ends access here, and its copy is removed', async ({
  browser,
}: {
  browser: Browser;
}) => {
  const email = newEmail();
  const owner = await browser.newContext();
  const viewer = await browser.newContext();
  const ownerPage = await owner.newPage();
  const openPage = await viewer.newPage();

  try {
    await signInAsNewAccount(ownerPage, email);
    const boardPath = await openNewBoard(ownerPage, 'Doomed board');

    await signIn(openPage, email);
    await openPage.goto(boardPath);
    await expect(openPage.getByRole('heading', { name: 'Doomed board' })).toBeVisible();
    await expect(connection(openPage)).toHaveText('Online', { timeout: 15_000 });

    // The owner deletes the board from the dashboard.
    await ownerPage.goto('/');
    await ownerPage
      .getByRole('listitem')
      .filter({ hasText: 'Doomed board' })
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    await ownerPage.getByRole('button', { name: 'Delete board' }).click();

    // The open page is told at once, and says that its copy was removed.
    await expect(openPage.getByRole('alert')).toContainText('Your access to this board has ended', {
      timeout: 15_000,
    });

    // Reloading shows that the board is gone; the removed copy is not used instead.
    await openPage.reload();
    await expect(openPage.getByText('Could not open this board.')).toBeVisible();
  } finally {
    await owner.close();
    await viewer.close();
  }
});
