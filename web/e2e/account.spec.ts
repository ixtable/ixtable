import {test, expect} from '@playwright/test';

test('unauthenticated visit to /account redirects to /login', async ({page}) => {
  await page.goto('/account');
  await page.waitForURL('**/login');
  await expect(page.getByTestId('login-tab-signin')).toBeVisible();
});
