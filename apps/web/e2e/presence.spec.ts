import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

// Two browser contexts sign in to one account and open the same board, the same way the sync spec
// does. Presence is ephemeral: nothing here reloads a page, and the checks read what the other
// browser shows in its toolbar and overlay.

const password = 'correct horse battery';

function participants(page: Page): Locator {
  return page.getByTestId('participant');
}

function remoteCursors(page: Page): Locator {
  return page.getByTestId('remote-cursor');
}

async function signUp(page: Page, email: string): Promise<void> {
  await page.goto('/register');
  await page.getByLabel('Display name').fill('Presence tester');
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

async function createBoard(page: Page, title: string): Promise<string> {
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

test('participants and cursors appear in another browser, and leave when it disconnects', async ({
  browser,
}: {
  browser: Browser;
}) => {
  const email = `presence-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const first = await browser.newContext();
  const second = await browser.newContext();
  const a = await first.newPage();
  const b = await second.newPage();

  try {
    await signUp(a, email);
    const boardPath = await createBoard(a, 'Presence board');

    await signIn(b, email);
    await b.goto(boardPath);
    await expect(b.getByRole('heading', { name: 'Presence board' })).toBeVisible();

    // Each browser sees itself and the other participant.
    await expect(participants(a)).toHaveCount(2, { timeout: 15_000 });
    await expect(participants(b)).toHaveCount(2, { timeout: 15_000 });
    await expect(b.getByText('Online')).toBeVisible();

    // A moves the pointer across the canvas; B shows the cursor, and it moves.
    const origin = await canvasOrigin(a);
    await a.mouse.move(origin.x + 120, origin.y + 120);
    await a.mouse.move(origin.x + 240, origin.y + 180, { steps: 8 });
    await expect(remoteCursors(b)).toHaveCount(1, { timeout: 10_000 });

    // A closes its browser without leaving: B's list drops to one participant.
    await first.close();
    await expect(participants(b)).toHaveCount(1, { timeout: 15_000 });
    await expect(remoteCursors(b)).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await second.close();
  }
});
