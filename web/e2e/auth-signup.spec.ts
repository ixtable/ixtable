import {test, expect} from '@playwright/test';
import {supabaseAvailable, uniqueEmail} from './helpers';

test.describe('signup', () => {
  test.skip(!supabaseAvailable(), 'Supabase is not running locally; start it with `supabase start`.');

  test('creates a new account and becomes authenticated', async ({page}) => {
    const email = uniqueEmail('signup');

    await page.goto('/login');
    await page.getByTestId('login-tab-signup').click();
    await page.getByTestId('login-email-input').fill(email);
    await page.getByTestId('login-password-input').fill('a-secure-password');
    await page.getByTestId('login-submit').click();

    await page.waitForURL('**/account');
    await expect(page.getByTestId('account-email')).toHaveText(email);
  });
});
