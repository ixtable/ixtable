import {test, expect} from '@playwright/test';
import {supabaseAvailable} from './helpers';
import {E2E_USER_EMAIL, E2E_USER_PASSWORD} from './global-setup';

test.describe('login', () => {
  test.skip(!supabaseAvailable(), 'Supabase is not running locally; start it with `supabase start`.');

  test('logs in with valid credentials and lands on /account', async ({page}) => {
    await page.goto('/login');
    await page.getByTestId('login-email-input').fill(E2E_USER_EMAIL);
    await page.getByTestId('login-password-input').fill(E2E_USER_PASSWORD);
    await page.getByTestId('login-submit').click();

    await page.waitForURL('**/account');
    await expect(page.getByTestId('account-email')).toHaveText(E2E_USER_EMAIL);
    await expect(page.getByTestId('navbar-account-link')).toBeVisible();
  });

  test('shows an error for the wrong password', async ({page}) => {
    await page.goto('/login');
    await page.getByTestId('login-email-input').fill(E2E_USER_EMAIL);
    await page.getByTestId('login-password-input').fill('not-the-password');
    await page.getByTestId('login-submit').click();

    await expect(page.getByTestId('login-error')).toBeVisible();
  });

  test('signs out and returns to the logged-out state', async ({page}) => {
    await page.goto('/login');
    await page.getByTestId('login-email-input').fill(E2E_USER_EMAIL);
    await page.getByTestId('login-password-input').fill(E2E_USER_PASSWORD);
    await page.getByTestId('login-submit').click();
    await page.waitForURL('**/account');

    await page.getByTestId('account-sign-out').click();
    await page.waitForURL('**/login');
    await expect(page.getByTestId('navbar-login-link')).toBeVisible();
  });
});
