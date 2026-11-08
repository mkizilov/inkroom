import { readFileSync } from 'node:fs';
import {
  expect,
  test,
  type Browser,
  type Download,
  type Locator,
  type Page,
} from '@playwright/test';

// Importing and exporting boards through the real API and canvas. The representative board covers
// every object type, with coordinates, text and stacking order that the export must give back.

const password = 'correct horse battery';

test.setTimeout(120_000);

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const representative = {
  format: 'inkroom.board',
  version: 1,
  title: 'Representative plan',
  exportedAt: '2026-01-02T09:30:00.000Z',
  region: null,
  objects: [
    {
      id: id(1),
      type: 'rectangle',
      x: 40,
      y: 40,
      width: 200,
      height: 120,
      stroke: '#1971c2',
      strokeWidth: 2,
      fill: '#a5d8ff',
    },
    {
      id: id(2),
      type: 'ellipse',
      x: 300,
      y: 60,
      width: 160,
      height: 100,
      stroke: '#2f9e44',
      strokeWidth: 3,
    },
    {
      id: id(3),
      type: 'arrow',
      x: 60,
      y: 220,
      dx: 220,
      dy: -60,
      stroke: '#e03131',
      strokeWidth: 2,
    },
    { id: id(4), type: 'line', x: 300, y: 260, dx: 180, dy: 0, stroke: '#1e1e1e', strokeWidth: 1 },
    {
      id: id(5),
      type: 'pen',
      x: 520,
      y: 80,
      points: [
        { x: 0, y: 0 },
        { x: 20, y: -15 },
        { x: 40, y: 5 },
        { x: 60, y: -10 },
      ],
      stroke: '#6741d9',
      strokeWidth: 3,
    },
    {
      id: id(6),
      type: 'text',
      x: 60,
      y: 340,
      text: 'Roadmap\nQ3 & Q4',
      stroke: '#1e1e1e',
      strokeWidth: 1,
      fontSize: 24,
    },
  ],
};

function status(page: Page): Locator {
  return page.getByRole('status', { name: 'Canvas status' });
}

async function signInAsNewAccount(page: Page, email: string): Promise<void> {
  await page.goto('/register');
  await page.getByLabel('Display name').fill('Import tester');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Your boards' })).toBeVisible();
}

function fileOf(value: unknown): { name: string; mimeType: string; buffer: Buffer } {
  return {
    name: 'plan.json',
    mimeType: 'application/json',
    buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
  };
}

async function importFile(page: Page, value: unknown): Promise<void> {
  await page.getByLabel('Import a board file').setInputFiles(fileOf(value));
}

async function openExportPanel(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Export' })).toBeVisible();
}

async function downloadFrom(page: Page, button: string): Promise<Download> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: button, exact: true }).click(),
  ]);
  return download;
}

test('a board imported from a file opens with its objects, and exports them back in the same order', async ({
  browser,
}: {
  browser: Browser;
}) => {
  const email = `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await signInAsNewAccount(page, email);
    await importFile(page, representative);

    await expect(page).toHaveURL(/\/boards\/[0-9a-f-]+$/);
    await expect(page.getByRole('heading', { name: 'Representative plan' })).toBeVisible();
    await expect(status(page)).toContainText('6 objects', { timeout: 15_000 });

    await openExportPanel(page);
    const json = await downloadFrom(page, 'Download JSON');
    expect(json.suggestedFilename()).toBe('representative-plan.json');
    const exported = JSON.parse(readFileSync(await json.path(), 'utf8')) as {
      format: string;
      version: number;
      title: string;
      region: unknown;
      objects: unknown[];
    };
    expect(exported).toMatchObject({
      format: 'inkroom.board',
      version: 1,
      title: 'Representative plan',
      region: null,
    });
    expect(exported.objects).toEqual(representative.objects);

    const svg = await downloadFrom(page, 'Download SVG');
    expect(svg.suggestedFilename()).toBe('representative-plan.svg');
    const svgText = readFileSync(await svg.path(), 'utf8');
    expect(svgText).toContain('<svg');
    expect(svgText).toContain('viewBox="');
    expect(svgText).toContain('Roadmap');
    expect(svgText).toContain('Q3 &amp; Q4');

    const png = await downloadFrom(page, 'Download PNG');
    expect(png.suggestedFilename()).toBe('representative-plan.png');
    const pngBytes = readFileSync(await png.path());
    expect(pngBytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  } finally {
    await context.close();
  }
});

test('a region export keeps the region and only the objects that touch it', async ({
  browser,
}: {
  browser: Browser;
}) => {
  const email = `region-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await signInAsNewAccount(page, email);
    await importFile(page, representative);
    await expect(status(page)).toContainText('6 objects', { timeout: 15_000 });

    await openExportPanel(page);
    await page.getByLabel('Region', { exact: true }).check();
    await page.getByLabel('X', { exact: true }).fill('280');
    await page.getByLabel('Y', { exact: true }).fill('40');
    await page.getByLabel('Width', { exact: true }).fill('200');
    await page.getByLabel('Height', { exact: true }).fill('120');

    const json = await downloadFrom(page, 'Download JSON');
    expect(json.suggestedFilename()).toBe('representative-plan-region.json');
    const exported = JSON.parse(readFileSync(await json.path(), 'utf8')) as {
      region: unknown;
      objects: Array<{ id: string }>;
    };
    expect(exported.region).toEqual({ x: 280, y: 40, width: 200, height: 120 });
    expect(exported.objects.map((object) => object.id)).toEqual([id(2)]);
    expect(exported.objects[0]).toEqual(representative.objects[1]);
  } finally {
    await context.close();
  }
});

test('a file that is not a board export is refused, and no board is created', async ({
  browser,
}: {
  browser: Browser;
}) => {
  const email = `refuse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await signInAsNewAccount(page, email);
    await importFile(page, '{"format":"something-else"}');

    await expect(page.getByRole('alert')).toContainText('not a valid InkRoom board export');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('listitem')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('a file from a later version of the format is refused, and the message names its version', async ({
  browser,
}: {
  browser: Browser;
}) => {
  const email = `version-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await signInAsNewAccount(page, email);
    await importFile(page, { ...representative, version: 2 });

    await expect(page.getByRole('alert')).toContainText('version 2');
    await expect(page).toHaveURL(/\/$/);
  } finally {
    await context.close();
  }
});
