import { test, expect } from "./fixtures/auth.js";

test.describe("Mobile layout", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("header", { timeout: 10_000 });
  });

  test("root container uses height:100% layout with overflow hidden", async ({ page }) => {
    const root = page.locator("header").locator("..");
    await expect(root).toHaveCSS("overflow", "hidden");
    // html and body should also be overflow:hidden (set via globals.css)
    const htmlOverflow = await page.evaluate(() => getComputedStyle(document.documentElement).overflow);
    expect(htmlOverflow).toBe("hidden");
  });

  test("header stays visible after viewport shrinks (keyboard simulation)", async ({ page }) => {
    const header = page.locator("header");
    const initialBox = await header.boundingBox();
    expect(initialBox).toBeTruthy();

    // Simulate keyboard opening: shrink viewport height
    const vp = page.viewportSize()!;
    await page.setViewportSize({ width: vp.width, height: Math.round(vp.height * 0.5) });
    await page.waitForTimeout(200);

    const afterBox = await header.boundingBox();
    expect(afterBox).toBeTruthy();
    expect(afterBox!.y).toBeGreaterThanOrEqual(0);
    expect(afterBox!.y + afterBox!.height).toBeLessThanOrEqual(
      Math.round(vp.height * 0.5) + 2,
    );
  });

  test("container height adjusts when viewport resizes", async ({ page }) => {
    const root = page.locator("header").locator("..");
    const vp = page.viewportSize()!;

    const smallHeight = 400;
    await page.setViewportSize({ width: vp.width, height: smallHeight });
    await page.waitForTimeout(200);

    const box = await root.boundingBox();
    expect(box).toBeTruthy();
    // Container height should be close to the new viewport height
    expect(box!.height).toBeLessThanOrEqual(smallHeight + 2);
    expect(box!.height).toBeGreaterThanOrEqual(smallHeight - 50);

    // Restore and check it grows back
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.waitForTimeout(200);
    const restored = await root.boundingBox();
    expect(restored!.height).toBeGreaterThanOrEqual(vp.height - 50);
  });

  test("header has search and settings icon buttons", async ({ page }) => {
    const header = page.locator("header");
    const svgButtons = header.locator("button:has(svg)");
    await expect(svgButtons).toHaveCount(2);
  });

  test("search button toggles search panel", async ({ page }) => {
    const header = page.locator("header");
    const searchBtn = header.locator("button:has(svg)").first();
    await searchBtn.click();

    // Search panel should appear after the header
    const searchInput = page.locator("input[placeholder*='搜索']");
    await expect(searchInput).toBeVisible({ timeout: 3000 });
  });

  test("settings button opens settings modal", async ({ page }) => {
    const header = page.locator("header");
    const settingsBtn = header.locator("button:has(svg)").last();
    await settingsBtn.click();

    await expect(page.locator("text=设置").first()).toBeVisible({ timeout: 3000 });
  });

  test("main area fills remaining space below header", async ({ page }) => {
    const main = page.locator("main");
    const mainBox = await main.boundingBox();
    const header = page.locator("header");
    const headerBox = await header.boundingBox();

    expect(mainBox).toBeTruthy();
    expect(headerBox).toBeTruthy();
    // Main should start right after header
    expect(mainBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height - 2);
    // Main + header should roughly fill the viewport
    const vp = page.viewportSize()!;
    expect(mainBox!.y + mainBox!.height).toBeGreaterThanOrEqual(vp.height - 10);
  });

  test("input area stays visible after viewport shrinks", async ({ page }) => {
    const textarea = page.locator("textarea, input[placeholder*='消息']").first();
    await expect(textarea).toBeVisible();

    const vp = page.viewportSize()!;
    await page.setViewportSize({ width: vp.width, height: Math.round(vp.height * 0.5) });
    await page.waitForTimeout(200);

    const box = await textarea.boundingBox();
    expect(box).toBeTruthy();
    const newHeight = Math.round(vp.height * 0.5);
    // Input should still be within or near the visible viewport
    expect(box!.y + box!.height).toBeLessThanOrEqual(newHeight + 50);
  });
});
