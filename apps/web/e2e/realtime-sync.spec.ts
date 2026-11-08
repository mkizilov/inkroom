import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

// Two browser contexts, each with its own cookies, sign in to the same account and open the same
// board. Membership management does not exist yet, so one account stands in for two people. The
// checks go through the real WebSocket sync path: nothing reloads, and the second browser only
// changes when the first one edits.

const password = 'correct horse battery';

function status(page: Page): Locator {
  return page.getByRole('status', { name: 'Canvas status' });
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
  await page.getByLabel('Display name').fill('Sync tester');
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
  await expect(page.getByRole('status', { name: 'Connection status' })).toHaveText('Online', {
    timeout: 15_000,
  });
  return new URL(page.url()).pathname;
}

test('drawing, moving and deleting in one browser updates another without a refresh', async ({
  browser,
}: {
  browser: Browser;
}) => {
  const email = `sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

  const first = await browser.newContext();
  const second = await browser.newContext();
  const a = await first.newPage();
  const b = await second.newPage();

  try {
    await signInAsNewAccount(a, email);
    const boardPath = await openNewBoard(a, 'Live board');

    await signIn(b, email);
    await b.goto(boardPath);
    await expect(b.getByRole('heading', { name: 'Live board' })).toBeVisible();
    await expect(status(b)).toHaveText('0 objects');

    // Draw in A: B shows the new object with no reload.
    await tool(a, 'Rectangle').click();
    const origin = await canvasOrigin(a);
    await drag(
      a,
      { x: origin.x + 200, y: origin.y + 200 },
      { x: origin.x + 300, y: origin.y + 260 },
    );
    await expect(status(a)).toHaveText('1 object · 1 selected · 100 × 60 at 200, 200');
    await expect(status(b)).toContainText('1 object', { timeout: 10_000 });

    // Move in A. The top edge is grabbed away from the resize handles, so this moves the object.
    // The status line only shows a position for a selected object, so B selects it to read it.
    await tool(a, 'Select').click();
    await drag(
      a,
      { x: origin.x + 230, y: origin.y + 200 },
      { x: origin.x + 290, y: origin.y + 200 },
    );
    await expect(status(a)).toContainText('at 260, 200');

    const originB = await canvasOrigin(b);
    await b.mouse.click(originB.x + 290, originB.y + 200);
    await expect(status(b)).toContainText('at 260, 200', { timeout: 10_000 });

    // Delete in A: B shows the object gone.
    await a.keyboard.press('Delete');
    await expect(status(a)).toHaveText('0 objects');
    await expect(status(b)).toHaveText('0 objects', { timeout: 10_000 });

    expect(b.url()).toContain(boardPath);
  } finally {
    await first.close();
    await second.close();
  }
});
