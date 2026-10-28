import { expect, test } from "@playwright/test";
import { login, OWNER } from "./helpers";

test("creator filter narrows the creators and content views", async ({ page }) => {
  await login(page, OWNER);
  await page.goto("/creators");
  await page.waitForLoadState("networkidle"); // let the filter bar hydrate
  expect(await page.getByRole("row").count()).toBeGreaterThanOrEqual(4); // header + at least the 3 demo creators
  await page.getByLabel("Creator").selectOption({ label: "Milo Moves (demo)" });
  await expect(page).toHaveURL(/creator=[0-9a-f-]{36}/);
  await expect(page.getByRole("row")).toHaveCount(2);
  await expect(page.getByRole("cell", { name: /Milo Moves/ })).toBeVisible();

  await page.goto(page.url().replace("/creators", "/content"));
  await expect(page.getByRole("cell", { name: /Lena Studio/ })).toHaveCount(0);
  await expect(page.getByRole("cell", { name: /Milo Moves: demo item/ }).first()).toBeVisible();
});

test("invalid filter values are ignored, not fatal", async ({ page }) => {
  await login(page, OWNER);
  const res = await page.goto("/content?creator=not-a-uuid&platform=MYSPACE&period=forever&status=DROP");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Content Factory" })).toBeVisible();
});
