import { test, expect } from "./fixtures/auth.js";

test.describe("Pet assets", () => {
  test.beforeEach(async ({ page }) => {
    // Let the bundled asset win: the shared fixture stubs an override image.
    await page.route("**/api/pet-images/**", (route) => route.fulfill({ status: 404 }));
    await page.goto("/");
    await page.waitForSelector("header", { timeout: 10_000 });
  });

  test("bundled webp decodes at the 256px tier for the full pet", async ({ page }) => {
    const pet = page.locator("div.fixed.left-4.bottom-4 img[alt='pet']").first();
    await expect(pet).toBeVisible();
    await expect(pet).toHaveJSProperty("complete", true);

    // The state is app-driven once connected, so assert the tier, not the state.
    const decoded = await pet.evaluate((el: HTMLImageElement) => ({
      width: el.naturalWidth,
      src: el.currentSrc,
    }));
    expect(decoded.width).toBe(256);
    expect(decoded.src).toMatch(/-256\.webp/);
  });
});
