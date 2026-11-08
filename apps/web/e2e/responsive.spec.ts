import { expect, test, type Page } from '@playwright/test';

// Pages must fit a phone-sized screen without scrolling sideways.

test.use({ viewport: { width: 375, height: 667 } });

const password = 'correct horse battery';

// How far the page is wider than the screen. Zero or less means no sideways scrolling.
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

test('the sign-in page fits a phone-sized screen', async ({ page }) => {
  await page.goto('/login');

  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test('the dashboard fits a phone-sized screen', async ({ page }) => {
  const email = `responsive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await page.goto('/register');
  await page.getByLabel('Display name').fill('Phone tester');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Your boards' })).toBeVisible();

  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});
