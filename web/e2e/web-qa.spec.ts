import {expect, test, type Page} from '@playwright/test';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const outputDir = path.join(process.cwd(), 'web-qa', '.generated');

async function capture(
  page: Page,
  name: string,
  expectations: string[],
): Promise<void> {
  await mkdir(outputDir, {recursive: true});
  await page.screenshot({path: path.join(outputDir, `${name}.png`), fullPage: true});
  await writeFile(
    path.join(outputDir, `${name}.json`),
    `${JSON.stringify({name, capturedAt: new Date().toISOString(), expectations}, null, 2)}\n`,
  );
}

test.describe('web QA', () => {
  test('landing page communicates the product clearly on desktop', async ({page}) => {
    await page.setViewportSize({width: 1440, height: 1000});
    await page.goto('/');

    await expect(page.getByRole('heading', {level: 1})).toHaveText(
      /Keep every project\s*beautifully clear\./,
    );
    await expect(page.getByRole('link', {name: /Get started free/i})).toBeVisible();
    await expect(page.getByLabel('Preview of the ixtable project workspace')).toBeVisible();
    await expect(page.getByRole('heading', {name: /Less time managing work/i})).toBeVisible();
    const workspacePhoto = page.getByRole('img', {name: /tidy workspace/i});
    await expect(workspacePhoto).toBeVisible();
    await expect.poll(() => workspacePhoto.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    await expect(page.locator('main')).not.toHaveCSS('overflow-x', 'scroll');

    await capture(page, 'landing-01-desktop', [
      'The hero, primary action, and ixtable product preview are visible above the fold.',
      'Feature sections form a clear editorial rhythm without clipped or overlapping content.',
      'The final call to action is visible at the bottom of the page.',
    ]);
  });

  test('landing page remains usable on mobile', async ({page}) => {
    await page.setViewportSize({width: 390, height: 844});
    await page.goto('/');

    await expect(page.getByRole('heading', {level: 1})).toBeVisible();
    await expect(page.getByRole('link', {name: /Get started free/i})).toBeVisible();
    await expect(page.getByLabel('Preview of the ixtable project workspace')).toBeVisible();
    const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(pageWidth).toBeLessThanOrEqual(390);

    await capture(page, 'landing-02-mobile', [
      'Hero copy and calls to action fit the viewport without horizontal scrolling.',
      'The product preview and feature sections collapse into a readable single column.',
      'Text remains legible and no content is visibly clipped.',
    ]);
  });
});
