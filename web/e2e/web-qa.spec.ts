import { expect, test, type Page } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const outputDir = path.join(process.cwd(), "web-qa", ".generated");

async function capture(
  page: Page,
  name: string,
  expectations: string[],
  fullPage = true,
): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await page.locator("img").evaluateAll(async (images: HTMLImageElement[]) => {
    for (const image of images) image.loading = "eager";
    await Promise.all(
      images.map((image) =>
        image.complete && image.naturalWidth > 0
          ? Promise.resolve()
          : new Promise<void>((resolve, reject) => {
              image.addEventListener("load", () => resolve(), { once: true });
              image.addEventListener(
                "error",
                () => reject(new Error(`Failed to load ${image.src}`)),
                { once: true },
              );
            }),
      ),
    );
  });
  await page.screenshot({ path: path.join(outputDir, `${name}.png`), fullPage });
  await writeFile(
    path.join(outputDir, `${name}.json`),
    `${JSON.stringify({ name, capturedAt: new Date().toISOString(), expectations }, null, 2)}\n`,
  );
}

async function darkPixelsInFlowCanvas(page: Page, imageName: RegExp): Promise<number> {
  const image = page.getByRole("img", { name: imageName });
  await expect(image).toBeVisible();
  await image.evaluate(async (element: HTMLImageElement) => {
    element.loading = "eager";
    await element.decode();
  });
  return image.evaluate((element: HTMLImageElement) => {
    const canvas = document.createElement("canvas");
    canvas.width = element.naturalWidth;
    canvas.height = element.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas context is unavailable.");
    context.drawImage(element, 0, 0);
    // The workspace screenshots reserve the upper-right area for React Flow.
    // Count dark pixels there so a decoded but empty canvas cannot pass QA.
    const x = Math.floor(canvas.width * 0.17),
      y = Math.floor(canvas.height * 0.17);
    const width = Math.floor(canvas.width * 0.81),
      height = Math.floor(canvas.height * 0.35);
    const pixels = context.getImageData(x, y, width, height).data;
    let dark = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (
        pixels[index] < 180 &&
        pixels[index + 1] < 180 &&
        pixels[index + 2] < 180 &&
        pixels[index + 3] > 0
      )
        dark++;
    }
    return dark;
  });
}

test.describe("web QA", () => {
  test.beforeAll(async () => {
    await Promise.all(
      ["docs-01-overview-desktop", "docs-02-data-view-desktop", "docs-03-overview-mobile"].flatMap(
        (name) => [
          rm(path.join(outputDir, `${name}.png`), { force: true }),
          rm(path.join(outputDir, `${name}.json`), { force: true }),
        ],
      ),
    );
  });

  test("documentation screenshots show current generated assets", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/docs/");
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
    await expect(page.getByRole("img", { name: /project open in Data view/i })).toBeVisible();
    await capture(page, "docs-01-overview-desktop", [
      "The overview page shows the current Data view screenshot.",
      "Documentation navigation and article content are fully visible.",
    ]);

    await page.goto("/docs/concepts/data-view");
    await expect(page.getByRole("heading", { level: 1, name: "Data view" })).toBeVisible();
    expect(await darkPixelsInFlowCanvas(page, /full Data view workspace/i)).toBeGreaterThan(2_000);
    expect(await darkPixelsInFlowCanvas(page, /new order entered/i)).toBeGreaterThan(2_000);
    const flowImage = page.getByRole("img", { name: /Customers, Products, Orders/i });
    await expect(flowImage).toBeVisible();
    await flowImage.evaluate(async (image: HTMLImageElement) => {
      image.loading = "eager";
      await image.decode();
    });
    await flowImage.scrollIntoViewIfNeeded();
    await page.waitForTimeout(100);
    await capture(
      page,
      "docs-02-data-view-desktop",
      [
        "The Data view article is positioned at the React Flow close-up.",
        "All four table nodes and their relationships are readable in the article.",
      ],
      false,
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/docs/");
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await capture(page, "docs-03-overview-mobile", [
      "The overview article and current screenshot fit a mobile viewport.",
      "The page has no horizontal scrolling or clipped content.",
    ]);
  });

  test("landing page communicates the product clearly on desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/");

    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      /Build the app\s*your business needs\./,
    );
    await expect(page.getByRole("link", { name: /Get started free/i })).toBeVisible();
    await expect(page.getByLabel("Preview of the ixtable app builder")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /More capable than a spreadsheet/i }),
    ).toBeVisible();
    await expect(page.getByRole("img", { name: /DataView TableView/i })).toBeVisible();
    expect(await darkPixelsInFlowCanvas(page, /DataView TableView/i)).toBeGreaterThan(2_000);
    await expect(page.getByRole("img", { name: /production form builder/i })).toBeVisible();
    await expect(page.getByRole("img", { name: /Published inventory app/i })).toBeVisible();
    const workspacePhoto = page.getByRole("img", { name: /tidy workspace/i });
    await expect(workspacePhoto).toBeVisible();
    await expect
      .poll(() => workspacePhoto.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);
    await expect(page.locator("main")).not.toHaveCSS("overflow-x", "scroll");

    await capture(page, "landing-01-desktop", [
      "The hero, primary action, and ixtable product preview are visible above the fold.",
      "Feature sections form a clear editorial rhythm without clipped or overlapping content.",
      "The final call to action is visible at the bottom of the page.",
    ]);
  });

  test("landing page remains usable on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: /Get started free/i })).toBeVisible();
    await expect(page.getByLabel("Preview of the ixtable app builder")).toBeVisible();
    const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(pageWidth).toBeLessThanOrEqual(390);

    await capture(page, "landing-02-mobile", [
      "Hero copy and calls to action fit the viewport without horizontal scrolling.",
      "The product preview and feature sections collapse into a readable single column.",
      "Text remains legible and no content is visibly clipped.",
    ]);
  });
});

test.describe("web QA: account pages", () => {
  test("pricing and log in pages fit a phone screen", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("button", { name: "Toggle navigation bar" }).click();
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Pricing" })
      .click();
    await expect(page.getByRole("heading", { level: 1, name: "Pricing" })).toBeVisible();
    const starter = await page.getByRole("region", { name: "Starter plan" }).boundingBox();
    expect(starter?.width ?? 0).toBeLessThanOrEqual(390);
    await capture(page, "cloud-01-pricing-mobile", [
      "The three plan cards stack in one column and each names its runtime user allowance.",
      "The page has no horizontal scrolling or clipped text.",
    ]);
    await page.getByRole("button", { name: "Toggle navigation bar" }).click();
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Log in" })
      .click();
    await expect(page.getByRole("button", { name: "Continue with Microsoft" })).toBeVisible();
    await capture(page, "cloud-02-login-mobile", [
      "The log in form, the Google and Microsoft buttons, and the not-configured note fit the phone width.",
      "Form controls show labels and are large enough to tap.",
    ]);
  });
});
