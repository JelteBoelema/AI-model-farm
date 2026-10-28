import { expect, test } from "@playwright/test";
import { login, OWNER } from "./helpers";

for (const path of ["/", "/creators", "/settings", "/workflows", "/costs", "/content", "/media", "/calendar", "/social", "/campaigns"]) {
  test(`no horizontal page scroll on mobile: ${path}`, async ({ page }) => {
    await login(page, OWNER);
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test("mobile navigation opens and navigates", async ({ page }) => {
  await login(page, OWNER);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("dialog").getByRole("link", { name: "Workflow Monitor" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Workflow Monitor" })).toBeVisible();
});
