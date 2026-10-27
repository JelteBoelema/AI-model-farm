import { expect, test } from "@playwright/test";
import { login, OWNER } from "./helpers";

test("owner pauses and resumes all publishing, with audit trail", async ({ page }) => {
  await login(page, OWNER);
  await page.goto("/settings");
  await page.getByLabel("Reason for pausing All publishing").fill("Platform API incident");
  await page.locator("li", { hasText: "All publishing" }).getByRole("button", { name: "Pause" }).click();
  await expect(page.getByText(/All publishing paused: Platform API incident/)).toBeVisible();

  await page.goto("/");
  await expect(page.getByText(/All publishing paused: Platform API incident/)).toBeVisible();

  await page.goto("/settings");
  await page.locator("li", { hasText: "All publishing" }).getByRole("button", { name: "Resume" }).click();
  await expect(page.getByText(/All publishing paused/)).toHaveCount(0);

  await page.goto("/settings/audit?q=control.");
  await expect(page.getByRole("cell", { name: "control.paused" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "control.resumed" })).toBeVisible();
});

test("a pause requires a reason", async ({ page }) => {
  await login(page, OWNER);
  await page.goto("/settings");
  await page.locator("li", { hasText: "All generation" }).getByRole("button", { name: "Pause" }).click();
  await expect(page.getByText(/reason of at least 3 characters/)).toBeVisible();
});
