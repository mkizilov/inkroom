import { expect, test, type Locator, type Page } from '@playwright/test';

// These specs need the API and PostgreSQL running (see playwright.config.ts). Each test registers
// its own account, so tests do not share data.

async function signUpAndOpenBoard(page: Page, title: string): Promise<void> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await page.goto('/register');
  await page.getByLabel('Display name').fill('Browser tester');
  await page.getByLabel('Email').fill(`e2e-${suffix}@example.com`);
  await page.getByLabel(/^Password/).fill('correct horse battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Your boards' })).toBeVisible();

  await page.getByLabel('New board name').fill(title);
  await page.getByRole('button', { name: 'Create board' }).click();
  await page
    .getByRole('listitem')
    .filter({ hasText: title })
    .getByRole('link', { name: 'Open' })
    .click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

interface Point {
  x: number;
  y: number;
}

function status(page: Page): Locator {
  return page.getByRole('status', { name: 'Canvas status' });
}

function tool(page: Page, name: string): Locator {
  return page.getByRole('button', { name, exact: true });
}

async function canvasOrigin(page: Page): Promise<Point> {
  const box = await page.getByRole('application', { name: 'Whiteboard canvas' }).boundingBox();
  if (!box) {
    throw new Error('the whiteboard canvas is not visible');
  }
  return { x: box.x, y: box.y };
}

// At the initial zoom the canvas origin is the world origin, so offsets are world units.
function at(origin: Point, x: number, y: number): Point {
  return { x: origin.x + x, y: origin.y + y };
}

async function drag(page: Page, from: Point, to: Point): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}

// Draws a 100 by 60 rectangle with its top-left corner at world (200, 200).
async function drawRectangle(page: Page): Promise<void> {
  await tool(page, 'Rectangle').click();
  const origin = await canvasOrigin(page);
  await drag(page, at(origin, 200, 200), at(origin, 300, 260));
  await expect(status(page)).toHaveText('1 object · 1 selected · 100 × 60 at 200, 200');
}

test.describe('whiteboard editing', () => {
  test.beforeEach(async ({ page }) => {
    await signUpAndOpenBoard(page, 'Editing checks');
  });

  test('undo and redo are unavailable until something changes', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
  });

  test('draws a rectangle, nudges it with the arrow keys, and undoes and redoes', async ({
    page,
  }) => {
    await drawRectangle(page);

    await page.keyboard.press('ArrowRight');
    await expect(status(page)).toContainText('at 201, 200');

    await page.keyboard.press('Control+z');
    await expect(status(page)).toContainText('at 200, 200');

    await page.keyboard.press('Control+Shift+z');
    await expect(status(page)).toContainText('at 201, 200');
  });

  test('resizes a selection from its bottom-right handle', async ({ page }) => {
    await drawRectangle(page);
    const origin = await canvasOrigin(page);

    // Select with the Select tool, then drag the bottom-right handle outwards.
    await tool(page, 'Select').click();
    await page.mouse.click(origin.x + 200, origin.y + 230);
    await expect(status(page)).toHaveText('1 object · 1 selected · 100 × 60 at 200, 200');

    await drag(page, at(origin, 300, 260), at(origin, 360, 300));
    await expect(status(page)).toHaveText('1 object · 1 selected · 160 × 100 at 200, 200');
  });

  test('deletes with the keyboard and restores the object with undo', async ({ page }) => {
    await drawRectangle(page);

    await page.keyboard.press('Delete');
    await expect(status(page)).toHaveText('0 objects');

    await page.keyboard.press('Control+z');
    await expect(status(page)).toHaveText('1 object');
  });

  test('duplicates the selection with Ctrl+D and selects the copy', async ({ page }) => {
    await drawRectangle(page);

    await page.keyboard.press('Control+d');

    await expect(status(page)).toHaveText('2 objects · 1 selected · 100 × 60 at 220, 220');
  });

  test('edits text in place and undoes the whole editing session in one step', async ({
    page,
  }) => {
    await tool(page, 'Text').click();
    const origin = await canvasOrigin(page);
    await page.mouse.click(origin.x + 200, origin.y + 200);

    const editor = page.getByRole('textbox', { name: 'Text object' });
    await editor.fill('Hello');
    await editor.press('Escape');
    await expect(status(page)).toContainText('1 object');

    await page.keyboard.press('Control+z');
    await expect(status(page)).toHaveText('0 objects');
  });

  test('draws a freehand stroke and removes it with undo', async ({ page }) => {
    await tool(page, 'Pen').click();
    const origin = await canvasOrigin(page);
    await page.mouse.move(origin.x + 200, origin.y + 300);
    await page.mouse.down();
    await page.mouse.move(origin.x + 240, origin.y + 320, { steps: 8 });
    await page.mouse.move(origin.x + 260, origin.y + 340, { steps: 8 });
    await page.mouse.up();
    await expect(status(page)).toContainText('1 object');

    await page.keyboard.press('Control+z');
    await expect(status(page)).toHaveText('0 objects');
  });
});
