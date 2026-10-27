import { expect, test } from "@playwright/test";
import { login, OWNER, VIEWER } from "./helpers";

test("viewer is read-only", async ({ page }) => {
  await login(page, VIEWER);
  await page.goto("/settings/users");
  await expect(page.getByRole("button", { name: "Add user" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Disable" })).toHaveCount(0);
  await page.goto("/settings");
  await expect(page.locator("li", { hasText: "All generation" }).getByRole("button", { name: "Pause" })).toBeDisabled();
  await page.goto("/providers");
  await expect(page.getByRole("button", { name: /Re-check credentials/ })).toHaveCount(0);
});

test("owner creates a user who can then sign in", async ({ page, browser }) => {
  await login(page, OWNER);
  await page.goto("/settings/users");
  await page.getByRole("button", { name: "Add user" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Otto Operator");
  await dialog.getByLabel("Email").fill("otto@e2e.local");
  await dialog.getByLabel("Role").selectOption("OPERATOR");
  await dialog.getByLabel("Initial password").fill("otto-initial-password");
  await dialog.getByRole("button", { name: "Create user" }).click();
  await expect(page.getByRole("cell", { name: /otto@e2e\.local/ })).toBeVisible();

  const other = await browser.newPage();
  await login(other, { email: "otto@e2e.local", password: "otto-initial-password" });
  await other.close();
});
