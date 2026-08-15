import {test, expect} from '@playwright/test';

test.describe('smoke', () => {
  test('home page renders', async ({page}) => {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Web Template');
    await expect(page.getByRole('link', {name: 'Docs'}).first()).toBeVisible();
  });

  test('docs page renders', async ({page}) => {
    await page.goto('/docs/intro');
    await expect(page.locator('h1')).toContainText('Introduction');
  });

  test('navbar shows a login link when signed out', async ({page}) => {
    await page.goto('/');
    await expect(page.getByTestId('navbar-login-link')).toBeVisible();
  });
});
