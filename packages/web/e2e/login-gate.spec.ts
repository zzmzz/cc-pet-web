import { test, expect } from "@playwright/test";

test.describe("Login gate", () => {
  test("shows login form when no token is set", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator("text=输入访问 Token")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("input[placeholder='请输入 token']")).toBeVisible();
    await expect(page.locator("button", { hasText: "进入" })).toBeVisible();
  });
});
