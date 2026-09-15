import { test, expect } from "./fixtures/auth.js";

// The bundled pet art is WebP. WebKit is the engine that would reject it, and a
// broken <img> renders blank rather than failing the build, so assert the bytes
// actually decode instead of trusting the src attribute.
test.describe("Pet assets", () => {
  test.beforeEach(async ({ page }) => {
    // Let the bundled asset win: the shared fixture stubs an override image.
    await page.route("**/api/pet-images/**", (route) => route.fulfill({ status: 404 }));
    await page.goto("/");
    await page.waitForSelector("header", { timeout: 10_000 });
  });

  test("bundled webp decodes at the 96px tier for the header avatar", async ({ page }) => {
    const avatar = page.locator("header img[alt='pet']").first();
    await expect(avatar).toBeVisible();

    // The state is app-driven once connected, so assert the tier, not the state.
    const decoded = await avatar.evaluate((el: HTMLImageElement) => ({
      width: el.naturalWidth,
      src: el.currentSrc,
    }));
    expect(decoded.width).toBe(96);
    expect(decoded.src).toMatch(/-96\.webp/);
  });
});
