import { test, expect } from "./fixtures/auth.js";

test.describe("Desktop layout", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("header", { timeout: 10_000 });
  });

  test("uses non-fixed layout with sidebar", async ({ page }) => {
    const aside = page.locator("aside");
    await expect(aside).toBeVisible();

    const container = aside.locator("..");
    await expect(container).not.toHaveCSS("position", "fixed");
  });

  test("sidebar has correct width (w-72 = 288px)", async ({ page }) => {
    const aside = page.locator("aside");
    const box = await aside.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.width).toBeGreaterThanOrEqual(280);
    expect(box!.width).toBeLessThanOrEqual(296);
  });

  test("header shows text settings button, no icon buttons", async ({ page }) => {
    const header = page.locator("header");
    await expect(header.locator("button", { hasText: "设置" })).toBeVisible();
    const svgButtons = header.locator("button:has(svg)");
    await expect(svgButtons).toHaveCount(0);
  });

  test("PetFull is positioned at bottom-left", async ({ page }) => {
    const pet = page.locator("div.fixed.left-4.bottom-4").first();
    await expect(pet).toBeVisible();
    const box = await pet.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.x).toBeLessThanOrEqual(32);
    const vp = page.viewportSize()!;
    expect(box!.y + box!.height).toBeGreaterThanOrEqual(vp.height - 100);
  });
});
