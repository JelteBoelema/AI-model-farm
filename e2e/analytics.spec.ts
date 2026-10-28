import { expect, test } from "@playwright/test";
import { login, OWNER, VIEWER } from "./helpers";

test("analytics keeps demo, mock and measured results apart and labels predictions", async ({ page }) => {
  await login(page, OWNER);
  await page.goto("/analytics?origin=demo&period=all");
  await expect(page.getByRole("note").getByText("Seeded demonstration data")).toBeVisible();
  const totals = page.getByLabel("Demo totals");
  await expect(totals.getByText("Published posts")).toBeVisible();
  await expect(page.getByRole("table", { name: "By creator" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Top posts" })).toBeVisible();
  await expect(page.getByText("Prediction — not measured")).toBeVisible();

  // Nothing measured yet: the measured view is empty instead of borrowing demo numbers.
  await page.getByRole("navigation", { name: "Data origin" }).getByRole("link", { name: /Measured/ }).click();
  await expect(page.getByText("No measured results")).toBeVisible();
  await expect(page.getByLabel("Measured totals")).toHaveCount(0);

  await page.getByRole("button", { name: "Collect statistics now" }).click();
  await expect(page.getByText(/Collected \d+ snapshot\(s\) from \d+ account\(s\)/)).toBeVisible();
});

test("a viewer reads analytics but cannot trigger collection", async ({ page }) => {
  await login(page, VIEWER);
  await page.goto("/analytics?origin=demo&period=all");
  await expect(page.getByLabel("Demo totals")).toBeVisible();
  await expect(page.getByRole("button", { name: "Collect statistics now" })).toHaveCount(0);
});
