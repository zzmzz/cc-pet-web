import { test, expect } from "./fixtures/auth.js";

function seedTwoSessions(page: import("@playwright/test").Page) {
  const sessions = [
    { key: "session-1", connectionId: "e2e-bridge", createdAt: 1000, lastActiveAt: 2000, label: "会话一" },
    { key: "session-2", connectionId: "e2e-bridge", createdAt: 1000, lastActiveAt: 3000, label: "会话二" },
  ];

  const historyByChat: Record<string, unknown[]> = {
    "e2e-bridge::session-1": [
      { id: "m1", role: "user", content: "你好 session1", timestamp: 1500 },
      { id: "m2", role: "assistant", content: "回复 session1", timestamp: 1600 },
    ],
    "e2e-bridge::session-2": [
      { id: "m3", role: "user", content: "你好 session2", timestamp: 2500 },
      { id: "m4", role: "assistant", content: "回复 session2", timestamp: 2600 },
    ],
  };

  return {
    sessions,
    routeSessions: () =>
      page.route("**/api/sessions**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ sessions }),
        }),
      ),
    routeHistory: () =>
      page.route("**/api/history/**", (route) => {
        const url = new URL(route.request().url());
        const chatKey = decodeURIComponent(url.pathname.split("/api/history/")[1] ?? "");
        const messages = historyByChat[chatKey] ?? [];
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ messages }),
        });
      }),
  };
}

async function switchToOtherSession(page: import("@playwright/test").Page) {
  const isMobile = !await page.locator("aside").isVisible().catch(() => false);
  if (isMobile) {
    // Mobile: click the dropdown trigger (has "▼")
    const trigger = page.locator("header").locator("button", { hasText: "▼" });
    await trigger.click();
    await page.waitForTimeout(300);
    const recentSection = page.locator("text=最近会话").locator("..");
    const sessionItem = recentSection.locator("[role=button]").first();
    if (await sessionItem.isVisible()) {
      await sessionItem.click();
    }
  } else {
    // Desktop: sessions are in the sidebar panel, click in "最近会话"
    const aside = page.locator("aside");
    const recentSection = aside.locator("text=最近会话").locator("..");
    const sessionItem = recentSection.locator("[role=button]").first();
    await sessionItem.click();
  }
}

test.describe("Session switching", () => {
  test.beforeEach(async ({ page }) => {
    const seed = seedTwoSessions(page);
    await page.unrouteAll({ behavior: "ignoreErrors" });

    await page.route("**/api/auth/verify", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ valid: true, name: "e2e", bridgeIds: ["e2e-bridge"] }),
      }),
    );
    await page.route("**/api/link-preview**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) }),
    );
    await page.route("**/api/pet-images/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: "<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/>",
      }),
    );
    await seed.routeSessions();
    await seed.routeHistory();

    await page.goto("/");
    await page.waitForSelector("header", { timeout: 10_000 });
  });

  test("shows messages for the initially active session", async ({ page }) => {
    const hasSession1 = page.locator("text=你好 session1");
    const hasSession2 = page.locator("text=你好 session2");
    await expect(hasSession1.or(hasSession2)).toBeVisible({ timeout: 5000 });
  });

  test("header and input remain visible after switching sessions", async ({ page }) => {
    await page.waitForSelector("textarea", { timeout: 5000 });

    const header = page.locator("header");
    await expect(header).toBeVisible();

    await switchToOtherSession(page);

    await expect(header).toBeVisible();
    await expect(page.locator("textarea").first()).toBeVisible();
  });

  test("switching session shows different messages", async ({ page }) => {
    await page.waitForSelector("textarea", { timeout: 5000 });
    await page.waitForTimeout(1000);

    const session2Visible = await page.locator("text=你好 session2").isVisible().catch(() => false);
    const expectedMsg = session2Visible ? "你好 session1" : "你好 session2";

    await switchToOtherSession(page);

    await expect(page.locator(`text=${expectedMsg}`)).toBeVisible({ timeout: 5000 });
  });

  test("main content area is not empty after session switch", async ({ page }) => {
    await page.waitForSelector("textarea", { timeout: 5000 });
    await page.waitForTimeout(500);

    const main = page.locator("main");
    const mainBox = await main.boundingBox();
    expect(mainBox).toBeTruthy();
    expect(mainBox!.height).toBeGreaterThan(50);

    await switchToOtherSession(page);

    const afterMain = await main.boundingBox();
    expect(afterMain).toBeTruthy();
    expect(afterMain!.height).toBeGreaterThan(50);
    await expect(page.locator("textarea").first()).toBeVisible();
  });
});
