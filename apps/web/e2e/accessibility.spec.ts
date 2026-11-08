import { expect, test, type Page } from '@playwright/test';

// Keyboard and focus behaviour of the app shell and the forms, checked in a real browser.

const password = 'correct horse battery';

function uniqueEmail(): string {
  return `a11y-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

async function registerAndOpenDashboard(page: Page): Promise<void> {
  await page.goto('/register');
  await page.getByLabel('Display name').fill('Keyboard tester');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Your boards' })).toBeVisible();
}

test('the skip link moves keyboard focus to the page content', async ({ page }) => {
  await page.goto('/login');

  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
});

test('keyboard focus is shown with a visible outline', async ({ page }) => {
  await page.goto('/login');

  await page.getByLabel('Email').focus();

  const outline = await page
    .getByLabel('Email')
    .evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(outline).toBe('solid');
});

test('a failed sign-in is announced without a mouse', async ({ page }) => {
  await page.goto('/login');

  await page.getByLabel('Email').fill('nobody-here@example.com');
  await page.getByLabel('Password').fill('wrong-password-123');
  await page.getByLabel('Password').press('Enter');

  await expect(page.getByRole('alert')).toBeVisible();
});

test('the dashboard controls can all be reached with the keyboard', async ({ page }) => {
  await registerAndOpenDashboard(page);

  await page.getByLabel('New board name').focus();
  await page.keyboard.type('Keyboard board');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Create board' })).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('listitem').filter({ hasText: 'Keyboard board' }),
  ).toBeVisible();
});
